'use strict';
const EventEmitter = require('events').EventEmitter;
const util = require('util');
const request = require('./helpers/request');
const logger = require('./helpers/logger');
const DEFAULT_RETRY_INTERVAL = 5000;
const DEFAULT_SUBSCRIPTION_INTERVAL = 600;
const RETRIES_BEFORE_CONSIDERED_DEAD = 5;

const RECONNECT_TIMER_ID = setInterval(() => {
  const errorMap = SoundServiceErrorWatcher.errorMap;
  if(typeof errorMap !== "undefined") {
    const keys = Object.keys(errorMap);
    const now = new Date().getTime();
    var oldErrors = 0;
    keys.forEach((key) => {
      const errorDate = errorMap[key];
      if(typeof errorDate !== "undefined") {
        const errorTime = errorDate.getTime();
        if((now - errorTime) > 20000) {
          oldErrors += 1;
        }
      }
    });

    if(oldErrors > 0) {
      logger.error(`had ${oldErrors} over 20 seconds ago, going away now`);
      process.exit(1);
    }
  }
}, 10000);

var SoundServiceErrorWatcher = exports.SoundServiceErrorWatcher = function () {
  if(typeof SoundServiceErrorWatcher.errorMap === "undefined") {
    var time = new Date();
    logger.warn(`created SoundServiceErrorWatcher at ${time}`);
    SoundServiceErrorWatcher.errorMap = {};
  }
}

SoundServiceErrorWatcher.prototype.recordError = function (name) {
  const host = this.getHost(name);
  var errorValue = SoundServiceErrorWatcher.errorMap[host];
  var now = new Date().getTime();
  if(typeof errorValue === "undefined") {
      SoundServiceErrorWatcher.errorMap[host] = new Date();
      logger.warn(`recording new error on ${host}`)
      return;
  }

  var firstError = SoundServiceErrorWatcher.errorMap[host].getTime();

  if ((now - firstError) > 45000) {
      // could have been a transient error and it recovered
      logger.warn(`old error for ${host} has been replaced with new one`);
      SoundServiceErrorWatcher.errorMap[host] = new Date();
  }
  else if ((now - firstError) > 5000) {
      logger.error(`had errors for 5 seconds on ${host}, going away now`);
      process.exit(1);
  }
}

SoundServiceErrorWatcher.prototype.clearError = function (name) {
  const host = this.getHost(name);
  if(typeof SoundServiceErrorWatcher.errorMap[host] !== "undefined") {
    delete SoundServiceErrorWatcher.errorMap[host];
    logger.warn("clearing error for `" + host + "`");
  }
}

SoundServiceErrorWatcher.prototype.getHost = function (subscribeUrl) {
  if(subscribeUrl) {
    return subscribeUrl.split("/")[2];
  }
  return "all-sonos";
}

function Subscriber(subscribeUrl, notificationUrl, _subscriptionInterval, _retryInterval) {
  const _this = this;
  let sid;
  let timer;
  let errorCount = 0;

  // This is configurable just for testing purposes
  const subscriptionInterval = _subscriptionInterval || DEFAULT_SUBSCRIPTION_INTERVAL;
  const retryInterval = _retryInterval || DEFAULT_RETRY_INTERVAL;

  this.dispose = function dispose() {
    clearTimeout(timer);
    request({
      headers: {
        SID: sid
      },
      uri: subscribeUrl,
      method: 'UNSUBSCRIBE',
      type: 'stream'
    }).then(() => {
      logger.trace('successfully unsubscribed from', subscribeUrl);
    }).catch((e) => {
      logger.error(`unsubscribe from sid ${sid} failed`, e);
    });
  };

  function subscribe() {
    clearTimeout(timer);
    let headers = {
      TIMEOUT: `Second-${subscriptionInterval}`
    };

    if (sid) {
      headers.SID = sid;
    } else {
      headers.CALLBACK = `<${notificationUrl}>`;
      headers.NT = 'upnp:event';
    }

    request({
      headers,
      uri: subscribeUrl,
      method: 'SUBSCRIBE',
      type: 'stream'
    }).then((res) => {
      sid = res.headers.sid;
      timer = setTimeout(subscribe, subscriptionInterval * 500);
      errorCount = 0;
      new SoundServiceErrorWatcher().clearError(subscribeUrl);
    }).catch((e) => {
      new SoundServiceErrorWatcher().recordError(subscribeUrl);
      logger.warn(`resubscribing to sid ${subscribeUrl} failed ${errorCount} times`, e);
      sid = null;
      errorCount++;
      timer = setTimeout(subscribe, retryInterval);

      if (errorCount === RETRIES_BEFORE_CONSIDERED_DEAD) {
        _this.emit('dead', `Endpoint has probably died`);
        setTimeout(function() {
          logger.error('subscribe failed too many times! exiting process, back soon');
          process.exit(1);
        }, 150);
      }
    });
  }

  subscribe();
}

util.inherits(Subscriber, EventEmitter);

module.exports = Subscriber;
