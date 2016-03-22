import log from './logger'
import path from 'path'

var os = require('os'),
    AWS = require('aws-sdk');

AWS.config = new AWS.Config({
  region: process.env.AWS_REGION || 'us-east-1'
});


var lambda = new AWS.Lambda();
var swf = new AWS.SWF();


var config = {
   "domain": process.env.DOMAIN || "testdomain",
   "taskList": {"name": process.env.ACTIVITIES_TASKLIST || "lambda-activity-tasklist"},
   "identity": 'LambdaActivityPoller-' + os.hostname() + '-' + process.pid,
};

log(config)

var stop_poller = false;

var _ = {
  clone: function (src) {
    var tgt = {}, k;
    for (k in src) {
       if (src.hasOwnProperty(k)) {
          tgt[k] = src[k];
       }
    }
    return tgt;
  }
};


export default function poll() {
   // Copy config
   var o = _.clone(config);

   log({event: "poll", type: 'activities'});

   // Poll request on AWS
   // http://docs.aws.amazon.com/amazonswf/latest/apireference/API_PollForActivityTask.html
   swf.pollForActivityTask(o, function (err, result) {

      if (err) {
        log({error: "polling", ...err});
        poll();
        return;
      }

      // If no new task, re-poll
      if (!result.taskToken) {
         poll();
         return;
      }

      _onNewTask(result);
      poll();
   });

};

function processActivityResult(taskToken, result) {
  var params = {
    taskToken: taskToken,
    result: JSON.stringify(result),
  }
  log({event: "activity-result", ...result});

  swf.respondActivityTaskCompleted(params, function(err, data) {
    if (err) log({error: err, stack: err.stack}); // an error occurred
    else     log({event: 'activity-completed', ...data});           // successful response
  })
}

var _onNewTask = function(task) {
  var activity = task.activityType.name
  var params = JSON.parse(task.input)
  params.activityToken = task.taskToken

  if (process.env.LOCAL_FUNCTIONS) {
    console.log('Invoking local', activity)
    var func = require('brain/functions/' + activity)
    const ctx = {
      succeed: function(result) {
        if (!result) {
          console.log('pausing activity')
          return
        }
        processActivityResult(task.taskToken, result)
      },
      fail: function(result) { console.log('fail:', result) },
      done: function(result) { console.log('done:', result) }
    }
    func.default(params, ctx)
  } else {
    var lambdaName = 'brain_' + activity
    var params = {
      FunctionName: lambdaName,
      InvocationType: 'RequestResponse',
      LogType: 'None',
      Payload: JSON.stringify(params)
    };
    log({event: 'invoke-lambda', ...params});
    lambda.invoke(params, function(err, data) {
      if (err) log({error: err, stack: err.stack});
      else     log({event: 'lambda-completed', ...data});
    });
  }
};
