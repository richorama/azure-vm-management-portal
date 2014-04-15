var azure = require('azure');

module.exports = function(settings){
	var tableService = azure.createTableService(settings.StorageAccount,settings.StorageKey);
	tableService.createTableIfNotExists("log", function(err){
	    if(err) console.log(err);
	});

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

	function queryLog(year, month, day, cb){
		var query = azure.TableQuery
	        .select()
	        .from("log")
	        .where('PartitionKey eq ?',  year + "-" + month + "-" + day);

	    queryEntities(query, function(error, entities, continuationToken){
	        if (error){
	            console.log(error);
	        }
	    	cb(error, entities || []);
	    }); 
	}


	return {
		log : log,
		error: logError,
		queryLog: queryLog
	}
}


function getLogPartitionKey(){
    var date = new Date();
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
}

