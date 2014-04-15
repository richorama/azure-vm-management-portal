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
var logger = require('./logging')(settings);
var emailer = require('./emailer')(settings, logger);

function getSms(sid){
	return parser.createServiceManagementService(azure, certs[sid]);
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
							logger.error(req, err);
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
			logger.error(req, err);
		}
		res.json(data.body)
	});
});

app.get("/:sid/vms/:name", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.getDeploymentBySlot(req.params.name,"production",function(err,data){
		if (err) {
			console.log(err);
			logger.error(err);
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
	logger.log(req, "stopped " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.shutdownRole(req.params.servicename,req.params.deploymentid,req.params.roleinstance,true,function(err,data){
		if (err) {
			console.log(err);
			logger.error(req, err);
		}
		res.json(data.body);
	});
});

app.post("/:sid/start/:servicename/:deploymentid/:roleinstance", ensureAuthenticated, function(req,res){
	logger.log(req, "started " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.startRole(req.params.servicename,req.params.deploymentid,req.params.roleinstance,function(err,data){
		if (err) {
			console.log(err);
			logger.error(req, err);
		}
		res.json(data.body);
	});
});

app.post("/:sid/deploy/:servicename/:imagename", ensureAuthenticated, function(req,res){
	logger.log(req, "deployed " + req.params.imagename + " to " + req.params.servicename);
	var vmpassword = generatePassword(12, false);

	var sms = getSms(req.params.sid);
	sms.createHostedService(req.params.servicename, {Location:settings.Location}, function(err,data){
		if (err){
			console.log(err);
			logger.error(req, err);
			res.json(data.body);	
		} else {

			var vmrole = {};
			vmrole.RoleName = req.params.servicename;
			vmrole.ConfigurationSets = [];

			vmrole.ConfigurationSets[0] = {
				ConfigurationSetType : "WindowsProvisioningConfiguration",
				ComputerName : "AZUREVM",
				AdminUsername : settings.VMUsername,
				AdminPassword : vmpassword,
				ResetPasswordOnFirstLogon : false
			}

			vmrole.ConfigurationSets[1] = {
				ConfigurationSetType : "NetworkConfiguration",
				InputEndpoints : 
				[{
					LocalPort : 80,
					Port : 80,
					Name : "HTTP",
					Protocol : "tcp"					
				},
				{
					LocalPort : 3389,
					Port : 3389,
					Name : "RDP",
					Protocol : "tcp"
				}]
			};		

			vmrole.OSVirtualHardDisk = {
				SourceImageName : req.params.imagename
			};

			sms.createDeployment(req.params.servicename,req.params.servicename,vmrole,{DeploymentSlot:"Production"}, function(err,data){
				if (err) {
					console.log(err);
					logger.error(req, err);
				}
				res.json(data.body);		
				emailer.vmCreateEmail(req.user, req.params.servicename, vmpassword);
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
			logger.error(req, err);
		}
	});
}

app.post("/:sid/delete/:servicename/:deploymentname", ensureAuthenticated, function(req,res){
	logger.log(req, "deleted " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.deleteDeployment(req.params.servicename, req.params.deploymentname, function(err, data){
		if (err) {
			console.log(err);
			logger.error(req, err);
		}
		setTimeout(deleteHostedService, 60*1000, req.params.sid, req.params.servicename);
		emailer.vmDeleteEmail(req.user, req.params.servicename);
		res.json(data.body);
	});
});

app.post("/:sid/delete/:servicename", ensureAuthenticated, function(req,res){
	logger.log(req, "deleted " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.deleteHostedService(req.params.servicename, function(err,data){
		emailer.vmDeleteEmail(req.user, req.params.servicename);		
		res.json(data.body);
	});
});

app.get("/:sid/images", ensureAuthenticated, function(req,res){
	var sms = getSms(req.params.sid);
	sms.listOSImage(function(err,data){
		if (err) {
			console.log(err);
			logger.error(req, err);
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
	logger.log(req, "mounted a disk on " + req.params.servicename);

	var sms = getSms(req.params.sid);
	var disk = {};
	disk.DiskName = req.params.disk;
	disk.Lun = 0;
	sms.addDataDisk(req.params.servicename, req.params.deployment, req.params.role, disk, function(err,data){
		if (err) {
			console.log(err);
			logger.error(req, err);
		}
		res.json(data);
	});
});

app.post("/:sid/unmount/:servicename/:deployment/:role/:lun", ensureAuthenticated, function(req,res){
	logger.log(req, "unmounted a disk on " + req.params.servicename);

	var sms = getSms(req.params.sid);
	sms.removeDataDisk(req.params.servicename, req.params.deployment, req.params.role, parseInt(req.params.lun), function(err,data){
		if (err) {
			console.log(err);
			logger.error(req, err);
		}
		res.json(data);
	});	
});

app.get("/:sid/disks", ensureAuthenticated, function(req, res){
	var sms = getSms(req.params.sid);
	sms.listDisks(function(err, data){
		if (err) {
			console.log(err);
			logger.error(req, err);
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
    var date = new Date();
    logger.queryLog(date.getFullYear(), date.getMonth() + 1, date.getDate(), function(err, data){
    	fixSubscriptionNames(data);
		res.json(data);
	}) 
});

app.get("/log/:year/:month/:day", ensureAuthenticated, function(req, res){
	logger.queryLog(req.params.year, req.params.month, req.params.day, function(err, data){
		fixSubscriptionNames(data);
		res.json(data);
	})   	
});

function fixSubscriptionNames(entities){
	if (!entities) return;
	entities.forEach(function(x){
		if (x.subscription){
			x.subscriptionName = subscriptions[x.subscription];
		}
	});
}

function isAdminAppSetting(emailAddress){
	return (settings.Administrators && settings.Administrators.indexOf(emailAddress) !== -1);
}

app.listen(process.env.port || 8080);
console.log("listening on port " + (process.env.port || 8080));