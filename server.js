var azure = require('azure')
var express = require('express');
var app = express();
var passport = require('passport');
var wsfedsaml2 = require('passport-azure-ad').WsfedStrategy;
var util = require('util')
var crypto = require('crypto');
var async = require('async');
var generatePassword = require('password-generator');

var fs = require('fs');
fs.existsSync = fs.existsSync || require('path').existsSync;

// load management certificates
var parser = require('azure-publishsettings-parser');
var subscriptions = {};
var certs = {};
parser.loadFromFile('accounts.publishsettings', function(err, subs){
    subs.forEach(function(x){
		subscriptions[x.Id] = x.Name;
		certs[x.Id] = x;
    });
});

var settings = {};
var filename = "settings.json";
if (process.env["APPSETTING_ENVIRONMENT"] && fs.existsSync(process.env["APPSETTING_ENVIRONMENT"] + ".json")){
    filename = process.env["APPSETTING_ENVIRONMENT"] + ".json"
} 
settings = JSON.parse(fs.readFileSync(filename).toString());

var sendgrid  = require('sendgrid')(settings.MailUsername, settings.MailPassword);

var secret = "2aec8596-efa2-4181-b781-4d723f5a8571";

var tableService = azure.createTableService(settings.StorageAccount,settings.StorageKey);
tableService.createTableIfNotExists("log", function(err){
    if(err) console.log(err);
});

function getSms(sid){
	return parser.createServiceManagementService(azure, certs[sid]);
}

function getLogPartitionKey(){
    var date = new Date();
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
}

function log(req, action){
	var now = Date.now();
	var entity = { 
		subscription: req.params.sid || "",
		message: action,
		RowKey: String(Math.pow(2, 53) - now),
		PartitionKey: getLogPartitionKey()
	}
	if (req.user){
		entity.userid = req.user.id || "";
		entity.useremail = req.user.email || "";
	} else {
		entity.userid = "";
		entity.useremail = "";
	}

	tableService.insertEntity("log", entity, function(err){
		if (err){
			console.log(err);
		}
	});	
}


function logError(req, message){
	var now = Date.now();
	var entity = { 
		message: JSON.stringify(message),
		RowKey: String(Math.pow(2, 53) - now),
		PartitionKey: getLogPartitionKey(),
	}
	if (req && req.user){
		entity.userid = req.user.id || "";
		entity.useremail = req.user.email || "";
		entity.subscription = req.params.sid || "";
	} else {
		entity.userid = "";
		entity.useremail = "";
		entity.subscription = "";
	}

	tableService.insertEntity("log", entity, function(err){
		if (err){
			console.log(err);
		}
	});	
}

function sendEmail(recipient, title, text){
	sendgrid.send({
	  to:       recipient,
	  from:     settings.MailFrom,
	  subject:  title,
	  html:     text
	}, function(error, json) {
	    if(error){
	        console.log(error);
	        logError(undefined, error);
	    }else{
	        console.log("sent email to " + recipient);
	        logError(undefined, "sent email to " + recipient);
	    }
	});
}

function hash(text){
	var shasum = crypto.createHash('sha1');
	text.forEach(function(x){
		shasum.update(x);
	});
	return shasum.digest('hex');
}

function vmCreateEmail(user, host, password){
	var message = "";
	message += "Dear " + user.displayName + ",<br/><br/>This email confirms that you have created a Virtual Machine called " + host + ".<br/>";
	message += "The machine will take a few minutes to start, and will be accessible on this url:<br/>";
	message += "<a href='http://" + host + ".cloudapp.net/ttrent_web'>http://" + host + ".cloudapp.net/</a><br/><br/>";
	message += "The username for the machine is " + settings.VMUsername + "<br/>";
	message += "The password for the machine is " + password + "<br/><br/>";
	message += "Please remember to delete your Virtual Machine when you have finished with it.";
	sendEmail(user.email, "New Virtual Machine", message);
}

function vmDeleteEmail(user, host){
	var message = "";
	message += "Dear " + user.displayName + ",<br/><br/>This email confirms that you have deleted a Virtual Machine called " + host + ".<br/>";
	sendEmail(user.email, "Deleted Virtual Machine", message);
}


// configure Express
app.configure(function() {
  app.use(express.logger());
  app.use(express.cookieParser());
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.session({ secret: 'f7270a2d-d699-4abc-8f0d-8fa7835f85e9' }));
  // Initialize Passport!  Also use passport.session() middleware, to support
  // persistent login sessions (recommended).
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(app.router);
});


/// auth

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});


var wsfedStrategy = new wsfedsaml2(settings.ActiveDirectoryConfig, function(profile, done) {
	console.log(profile);
    if (!profile.email) {
        done(new Error("No email found"));
        return;
    }
    done(null, profile);
});

passport.use(wsfedStrategy);

app.get('/auth/probe', function(req,res){
	if (req.isAuthenticated()) { 

		var subs = [];
		for (var x in subscriptions){
				subs.push({id:x,name:subscriptions[x]});
		}
		res.json({auth:true, admin: req.user.admin, displayName:req.user.displayName, subscriptions:subs});	
	} else {
		res.json({auth:false});
	}
});

app.get('/login', passport.authenticate('wsfed-saml2', { failureRedirect: '/', failureFlash: true }), function(req, res) {
   res.redirect('/');
});

app.post('/login/callback', passport.authenticate('wsfed-saml2', { failureRedirect: '/', failureFlash: true }), function(req, res) {
	console.log("auth callback");
  	req.user.admin = isAdminAppSetting(req.user.email)
    res.redirect('/');
});

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});


/// middleware

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.isAuthenticated() && isAdminAppSetting(req.user.email)) { return next(); }
  res.redirect('/login');
}

/// app routes

app.get('/', function(req, res){
	res.sendfile('_index.html');
});
app.get('/logo.png', function(req, res){
	res.sendfile('logo.png');
});

app.get("/:sid/all", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.listHostedServices(function(err,data){
		if (data && data.body){

			var tasks = [];
			data.body.forEach(function(service){

				var task = function(callback){
					var svc = service;
					sms.getDeploymentBySlot(svc.ServiceName,"production",function(err,data){
						if (err && !(err.code && err.code == "ResourceNotFound")) {
							console.log(err);
							logError(req, err);
						}
						if (data.body && data.body.RoleList){
							data.body.RoleList.forEach(function(x){
								if (x.DataVirtualHardDisks){
									x.DataVirtualHardDisks.forEach(function(y){
										var parts = y.MediaLink.split("/");
										y.DisplayName = parts[parts.length -1];
									});
								}				
							});
						}
						//response.services.push(data.body);
						svc.details = data.body;
						callback(null, svc);
					});
				}
				tasks.push(task);
			});
			async.parallel(tasks, function(err, results){
				res.json({services: results});
			});

		} else {
			res.json({services: []});
		}
	});

});

app.get("/:sid/vms", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.listHostedServices(function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		res.json(data.body)
	});
});

app.get("/:sid/vms/:name", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.getDeploymentBySlot(req.params.name,"production",function(err,data){
		if (err) {
			console.log(err);
			logError(err);
		}
		if (data.body && data.body.RoleList){
			data.body.RoleList.forEach(function(x){
				if (x.DataVirtualHardDisks){
					x.DataVirtualHardDisks.forEach(function(y){
						var parts = y.MediaLink.split("/");
						y.DisplayName = parts[parts.length -1];
					});
				}				
			});
		}

		res.json(data.body);
	});
});

app.post("/:sid/stop/:servicename/:deploymentid/:roleinstance", ensureAuthenticated, function(req,res){
	log(req, "stopped " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.shutdownRole(req.params.servicename,req.params.deploymentid,req.params.roleinstance,true,function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		res.json(data.body);
	});
});

app.post("/:sid/start/:servicename/:deploymentid/:roleinstance", ensureAuthenticated, function(req,res){
	log(req, "started " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.startRole(req.params.servicename,req.params.deploymentid,req.params.roleinstance,function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		res.json(data.body);
	});
});

app.post("/:sid/deploy/:servicename/:imagename", ensureAuthenticated, function(req,res){
	log(req, "deployed " + req.params.imagename + " to " + req.params.servicename);
	var vmpassword = generatePassword(12, false);

	var sms = getSms(req.params.sid);
	sms.createHostedService(req.params.servicename, {Location:"North Europe"}, function(err,data){
		if (err){
			console.log(err);
			logError(req, err);
			res.json(data.body);	
		} else {

			var vmrole = {};
			vmrole.RoleName = req.params.servicename;
			vmrole.ConfigurationSets = [];

			var set = {};
			vmrole.ConfigurationSets[0] = set;
			set.ConfigurationSetType = "WindowsProvisioningConfiguration";
			set.ComputerName = "AZUREVM";
			set.AdminUsername = settings.VMUsername;
			set.AdminPassword = vmpassword;
			set.ResetPasswordOnFirstLogon = false;

			var set2 = {};		
			vmrole.ConfigurationSets[1] = set2;
			set2.ConfigurationSetType = "NetworkConfiguration";

			set2.InputEndpoints = [];
			set2.InputEndpoints[0] = {};
			set2.InputEndpoints[0].LocalPort = 80;
			set2.InputEndpoints[0].Port = 80;
			set2.InputEndpoints[0].Name = "HTTP";
			set2.InputEndpoints[0].Protocol = "tcp";


			set2.InputEndpoints[1] = {};
			set2.InputEndpoints[1].LocalPort = 3389;
			set2.InputEndpoints[1].Port = 3389;
			set2.InputEndpoints[1].Name = "RDP";
			set2.InputEndpoints[1].Protocol = "tcp";

			vmrole.OSVirtualHardDisk = {};
			vmrole.OSVirtualHardDisk.SourceImageName = req.params.imagename;

			sms.createDeployment(req.params.servicename,req.params.servicename,vmrole,{DeploymentSlot:"Production"}, function(err,data){
				if (err) {
					console.log(err);
					logError(req, err);
				}
				res.json(data.body);		
				vmCreateEmail(req.user, req.params.servicename, vmpassword);
			});
		}
	});
});

function deleteHostedService(sid, name){
	var sms = getSms(sid);
	sms.deleteHostedService(name, function(err,data){
		if (err && err.code == "ConflictError") {
			setTimeout(deleteHostedService, 60*1000, sid, name);
		} else if (err) {
			console.log(err);
			logError(req, err);
		}
	});
}

app.post("/:sid/delete/:servicename/:deploymentname", ensureAuthenticated, function(req,res){
	log(req, "deleted " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.deleteDeployment(req.params.servicename, req.params.deploymentname, function(err, data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		setTimeout(deleteHostedService, 60*1000, req.params.sid, req.params.servicename);
		vmDeleteEmail(req.user, req.params.servicename);
		res.json(data.body);
	});
});

app.post("/:sid/delete/:servicename", ensureAuthenticated, function(req,res){
	log(req, "deleted " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.deleteHostedService(req.params.servicename, function(err,data){
		vmDeleteEmail(req.user, req.params.servicename);		
		res.json(data.body);
	});
});

app.get("/:sid/images", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.listOSImage(function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		var output = [];
		data.body.forEach(function(x){
			if (x.Category === 'User') {
				output.push(x);
			}
		});
		res.json(output);
	});
});

app.post("/:sid/mount/:servicename/:deployment/:role/:disk", ensureAuthenticated, function(req,res){
	log(req, "mounted a disk on " + req.params.servicename);

	var sms = getSms(req.params.sid);
	var disk = {};
	disk.DiskName = req.params.disk;
	disk.Lun = 0;
	sms.addDataDisk(req.params.servicename, req.params.deployment, req.params.role, disk, function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		res.json(data);
	});
});

app.post("/:sid/unmount/:servicename/:deployment/:role/:lun", ensureAuthenticated, function(req,res){
	log(req, "unmounted a disk on " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.removeDataDisk(req.params.servicename, req.params.deployment, req.params.role, parseInt(req.params.lun), function(err,data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		res.json(data);
	});	
});

app.get("/:sid/disks", ensureAuthenticated, function(req, res){
	var sms = getSms(req.params.sid);
	sms.listDisks(function(err, data){
		if (err) {
			console.log(err);
			logError(req, err);
		}
		var output = [];
		data.body.forEach(function(x){
			if (!x.OS && !x.AttachedTo){

				var parts = x.MediaLink.split("/");
				x.DisplayName = parts[parts.length -1];

				output.push(x);
			}
		});
		res.json(output);
	});
});

app.get("/rdp/:host/:port", ensureAuthenticated, function(req, res){
	res.setHeader('Content-Type', 'application/x-rdp');
	res.setHeader('Content-Disposition', 'attachment; filename=' + req.params.host + '.rdp');
	res.end("full address:s:" + req.params.host + ".cloudapp.net:" + req.params.port + "\r\nusername:s:" + settings.VMUsername + "\r\nprompt for credentials:i:1");
});

app.get("/log", ensureAuthenticated, function(req, res){
	var now = Date.now();
	var query = azure.TableQuery
        .select()
        .from("log")
        .where('PartitionKey eq ?', getLogPartitionKey());

    queryEntities(query, function(error, entities, continuationToken){
        if (error){
            console.log(error);
        }
    	if (entities){
    		entities.forEach(function(x){
    			if (x.subscription){
    				x.subscriptionName = subscriptions[x.subscription];
    			}
    		});
    	}
    	res.json(entities || []);
    });    	
});

app.get("/log/:year/:month/:day", ensureAuthenticated, function(req, res){
    var days = parseInt(req.params.days);

	var now = Math.pow(2, 53) - (Date.now() / (1000 * 60 * 60));
	var query = azure.TableQuery
        .select()
        .from("log")
        .where('PartitionKey eq ?',  req.params.year + "-" + req.params.month + "-" + req.params.day);

    queryEntities(query, function(error, entities, continuationToken){
        if (error){
            console.log(error);
        }
    	if (entities){
    		entities.forEach(function(x){
    			if (x.subscription){
    				x.subscriptionName = subscriptions[x.subscription];
    			}
    		});
    	}
    	res.json(entities || []);
    });    	
});

// queries results, and observes the continuation token
function queryEntities(query, cb) {
    tableService.queryEntities(query, function(error, entities, continuationToken){
        if (error){
            console.log(error);
        }
        if (!error && continuationToken.nextPartitionKey) { 
            pageResults(entities, continuationToken, cb);
        } else {
            cb(error, entities);                    
        }
    });
}

function pageResults(entities, continuationToken, cb){
    continuationToken.getNextPage(function(error, results, newContinuationToken){
        entities = entities.concat(results);
        if (!error && newContinuationToken.nextPartitionKey){
            pageResults(entities, newContinuationToken, cb);
        } else {
            cb(error, entities);
        }
    });
}

function isAdminAppSetting(emailAddress){
	return (settings.Administrators && settings.Administrators.indexOf(emailAddress) !== -1);
}

app.listen(process.env.port || 8080);
console.log("listening on port " + (process.env.port || 8080));