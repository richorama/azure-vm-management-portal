module.exports = function(settings, logger){
	var sendgrid  = require('sendgrid')(settings.MailUsername, settings.MailPassword);
	function sendEmail(recipient, title, text){
		sendgrid.send({
		  to:       recipient,
		  from:     settings.MailFrom,
		  subject:  title,
		  html:     text
		}, function(error, json) {
		    if(error){
		        console.log(error);
		        logger.error(undefined, error);
		    }else{
		        console.log("sent email to " + recipient);
		        logger.error(undefined, "sent email to " + recipient);
		    }
		});
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

	return {
		vmCreateEmail:vmCreateEmail,
		vmDeleteEmail:vmDeleteEmail
	}

}