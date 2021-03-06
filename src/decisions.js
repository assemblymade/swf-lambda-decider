import log from './logger'

var os = require('os'),
    AWS = require('aws-sdk'),
    uuid = require('uuid');

AWS.config = new AWS.Config({
  region: process.env.AWS_REGION || 'us-east-1'
});

var lambda = new AWS.Lambda();
var swfClient = new AWS.SimpleWorkflow();


var config = {
   "domain": process.env.DOMAIN || "testdomain",
   "taskList": {"name": process.env.DECISIONS_TASKLIST || "testtasklist"},
   "identity": 'Decider-' + os.hostname() + '-' + process.pid,
   "maximumPageSize": 100,
   "reverseOrder": false // IMPORTANT: must replay events in the right order, ie. from the start
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

   log({event: "poll", type: 'decisions'});

   // Poll request on AWS
   // http://docs.aws.amazon.com/amazonswf/latest/apireference/API_PollForDecisionTask.html
   swfClient.pollForDecisionTask(o, function (err, result) {
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

const SCHEDULE_ACTIVITY = 'SCHEDULE_ACTIVITY'
const SCHEDULE_MANUAL_ACTIVITY = 'SCHEDULE_MANUAL_ACTIVITY'
const FINISH_WORKFLOW = 'FINISH_WORKFLOW'

function createDecision(action) {
  switch (action.type) {
  case SCHEDULE_MANUAL_ACTIVITY:
  case SCHEDULE_ACTIVITY:
    if (action.type === SCHEDULE_MANUAL_ACTIVITY || process.env.LOCAL_FUNCTIONS) {
      return {
        decisionType: "ScheduleActivityTask",
        scheduleActivityTaskDecisionAttributes: {
          activityId: uuid.v4(),
          activityType:  {
            name: action.activity,
            version: (action.version || '1.0')
          },
          taskList:  { name: "activities" },
          input:  JSON.stringify(action.input),
        }
      }
    } else {
      return {
        decisionType: "ScheduleLambdaFunction",
        scheduleLambdaFunctionDecisionAttributes: {
          id: uuid.v4(),
          name: 'brain_' + action.activity,
          input:  JSON.stringify(action.input),
        }
      }
    }

  case FINISH_WORKFLOW:
    return {
      decisionType: "CompleteWorkflowExecution",
    }

  default:
  }
}

function processDecisionResult(taskToken, actions) {
  if (actions.length === 0) { return }
  log({event: 'decisions-pending', actions})
  var decisions = actions.map(createDecision)
  var params = {
    taskToken: taskToken,
    decisions: decisions,
  }
  swfClient.respondDecisionTaskCompleted(params, function(err, data) {
    if (err) log({error: err, stack: err.stack}); // an error occurred
    else     log({event: 'decision-completed', ...data});           // successful response
  })
}


var _onNewTask = function(originalResult,result, events) {
    //For the first call, events will not be passed.
    events = events || [];
    result = result || originalResult;
    events.push.apply(events,result.events);
    //If more pages are available, make call to fetch objects
    if(result.nextPageToken) {
        var pollConfig = _.clone(config);
        pollConfig.nextPageToken = result.nextPageToken;
        swfClient.pollForDecisionTask(pollConfig, function (err, nextPageResult) {
            if (err) {
                log({error: err, stack: err.stack});
                return;
            }
            _onNewTask(originalResult, nextPageResult, events);

        });
    } else {
        // No more pages available. Create decisionTask.
        originalResult.events = events
        var workflowType = originalResult.workflowType;
        var workflowName = workflowType.name;
        var workflowVersion = workflowType.version;
        log({event: 'decision-task', workflowName, workflowVersion})

        // var workflowLambdaName = (workflowName+'-'+workflowVersion).replace(/[^a-zA-Z0-9\-\_]/g, '_'); //letters, numbers, hyphens, or underscores

        if (process.env.LOCAL_FUNCTIONS) {
          const localFunction = 'brain/functions/' + workflowName
          console.log('Invoking local', localFunction)

          var lambda = require(localFunction + '/index')
          const ctx = {
            succeed: function(result) { processDecisionResult(originalResult.taskToken, result) },
            fail: function(result) { console.log('fail:', result) },
            done: function(result) { console.log('done:', result) }
          }
          lambda.default(originalResult, ctx)
        } else {
          var lambda = new AWS.Lambda();
          var workflowLambdaName = 'brain_' + workflowName
          var params = {
            FunctionName: workflowLambdaName,
            InvocationType: 'RequestResponse',
            LogType: 'None',
            Payload: JSON.stringify(originalResult)
          };

          log({event: 'invoke-lambda', ...params});
          lambda.invoke(params, function(err, data) {
            if (err) log({error: err, stack: err.stack}); // an error occurred
            else     processDecisionResult(originalResult.taskToken, JSON.parse(data.Payload));           // successful response
          });
        }

    }

};
