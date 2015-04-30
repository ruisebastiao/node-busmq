var http = require('http');
var _url = require('url');
var Should = require('should');
var redisHelper = require('./redis-helper');
var Bus = require('../lib/bus');

var fedserver;

var redisPorts = [9888,9889,9890,9891];
var redisUrls = [];
redisPorts.forEach(function(port) {
  redisUrls.push('redis://127.0.0.1:'+port);
});

var redises = [];

function redisStart(port, done) {
  console.log('<starting redis on port ' + port + '>');
  var redis = redisHelper.open(port);
  redises.push(redis);
  redis.on('error', function(err) {
    done(new Error(err));
  });
  redis.on('ready', function() {
    console.log('<redis started>');
    done();
  });
}

function redisStop(redis, done) {
  console.log('<closing redis>');
  redis.close(function() {
    console.log('<redis closed>');
    redises.splice(redises.indexOf(redis), 1);
    done();
  });
}

function redisMakeSlaveOf(redis1, redis2, done) {
  if (redis2) {
    console.log('<changing redis ' + redis1.port + ' to slave of ' + redis2.port + '>');
    redis1.slaveOf(redis2.port, function(err) {
      console.log('<redis is now slave>');
      done();
    });
  } else {
    console.log('<changing redis ' + redis1.port + ' to master>');
    redis1.slaveOf(null, function(err) {
      console.log('<redis is now master>');
      done();
    });
  }
}


function startAllRedises(cb) {
  console.log('<starting all redises>');
  var dones = 0;
  for (var i = 0; i < redisPorts.length; ++i) {
    redisStart(redisPorts[i], function() {
      if (++dones === redisPorts.length) {
        cb && cb();
      }
    });
  }
}

function stopAllRedises(cb) {
  console.log('<stopping all redises>');
  var dones = 0;
  for (var i = 0; i < redisPorts.length; ++i) {
    redisStop(redises[i], function() {
      if (++dones === redisPorts.length) {
        cb && cb();
      }
    });
  }
}

function produceAndConsume(bus, messages, queues, cb) {
  function qDone() {
    if (--queues === 0) {
      cb();
    }
  }

  for (var i = 0;i < queues; ++i) {
    (function() {
      var qName = 'test-'+i+'-'+Math.random();
      var testMessage = 'message-'+i;
      // create producer
      var p = bus.queue(qName);
      p.on('error', cb);
      p.on('detached', function() {
      });
      p.on('attached', function() {
        // create the consumer
        var c = bus.queue(qName);
        c.on('error', cb);
        c.on('message', function(message) {
          message.should.be.exactly(testMessage);
          if (c.consumed() === messages) {
            c.detach();
          }
        });
        c.on('detached', function() {
          qDone();
        });
        c.on('attached', function() {
          // consume all messages
          c.consume();
        });
        c.attach();

        // push messages
        var interval = setInterval(function() {
          do {
            p.push(testMessage);
            if (p.pushed() === messages) {
              clearInterval(interval);
              p.detach();
            }
          } while (p.isAttached() && p.pushed() % 20 !== 0)
        }, 0);
      });
      p.attach();
    })();
  }
}

function produceAndConsumeOverFederation(pBus, cBus, fedTo, messages, queues, cb) {
  function qDone() {
    if (--queues === 0) {
      cb();
    }
  }

  for (var i = 0; i < queues; ++i) {
    (function() {
      var qName = 'test-'+i+'-'+Math.random();
      var testMessage = 'message-'+i;
      // create producer
      var pFed = pBus.federate(pBus.queue(qName), fedTo);
      pFed.on('error', cb);
      pFed.on('unauthorized', function() {
        cb('unauthorized')
      });
      pFed.on('close', function() {
        qDone();
      });
      pFed.on('ready', function(p) {
        p.on('error', cb);
        p.on('detached', function() {
        });
        p.on('attached', function() {
          // create the consumer
          var c = cBus.queue(qName);
          c.on('error', cb);
          c.on('message', function(message) {
            message.should.be.exactly(testMessage);
            if (c.consumed() === messages) {
              c.detach();
            }
          });
          c.on('detached', function() {
            pFed.close();
          });
          c.on('attached', function() {
            // consume all messages
            c.consume();
          });
          c.attach();

          // push messages
          var pushed = 0;
          var interval = setInterval(function() {
            do {
              p.push(testMessage);
              if (++pushed === messages) {
                clearInterval(interval);
                p.detach();
              }
            } while (p.isAttached() && p.pushed() % 20 !== 0)
          }, 0);
        });
        p.attach();
      });
    })();
  }
}


describe('Bus', function() {

  this.timeout(0);
  if (this.timeout() === 0) {
    this.enableTimeouts(false);
  }

  // start the redis servers
  before(function(done) {
    startAllRedises(done);
  });

  // stop all redis servers
  after(function(done) {
    stopAllRedises(done);
  });

  describe('bus connection', function() {

    it('should emit online event when connected and offline event after disconnecting', function(done) {
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        bus.disconnect();
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('should emit error if calling connect twice', function(done) {
      var bus = Bus.create({redis: redisUrls, logger: console});
      var dones = 0;
      var onlines = 0;
      bus.on('error', function(err) {
        err.should.be.exactly('already connected');
        bus.disconnect();
      });
      bus.on('online', function() {
        if (++onlines === 1) {
          bus.connect('redis://127.0.0.1:'+redisPorts[0]);
        } else {
          done('online should not have been called twice');
        }
      });
      bus.on('offline', function() {
        ++dones;
        if (dones === 1) {
          done();
        } else if (dones > 1) {
          done('offline should not have been called twice');
        }
      });
      bus.connect();
    });

    it('should emit offline when the redises go down, and online when they are back again', function(done) {
      var bus = Bus.create({redis: redisUrls, logger: console});
      var onlines = 0;
      var offlines = 0;
      var allStopped= false;

      function startAll() {
        if (offlines === 1 && allStopped) {
          startAllRedises();
        }
      }

      bus.on('error', function(){});
      bus.on('online', function() {
        ++onlines;
        if (onlines === 1) {
          stopAllRedises(function() {
            allStopped = true;
            startAll();
          });
        } else if (onlines === 2) {
          bus.disconnect();
        } else {
          done('too many online events');
        }
      });
      bus.on('offline', function() {
        ++offlines;
        if (offlines === 1) {
          startAll();
        } else if (offlines === 2) {
          done();
        } else {
          done('too many offline events');
        }
      });
      bus.connect();
    });

    it('should resume silently when redis turns into slave and turns back to master', function(done) {
      var online = 0;
      var offline = 0;
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', function(){});
      bus.on('online', function() {
        ++online;
        if (online === 1) {
          online = true;
          redisMakeSlaveOf(redises[0], redises[1], function() {
            var q = bus.queue('test');
            q.on('attached', function() {
              setTimeout(function() {
                q.detach();
                redisMakeSlaveOf(redises[0], null, function() {
                  bus.disconnect();
                });
              }, 100);
            });
            q.attach();
          });
        }
      });
      bus.on('offline', function() {
        console.log('-- test is done');
        done();
      });
      bus.connect();
    });
  });

  describe('queues', function() {

    it('should receive attach/detach events', function(done) {
      var count = 0;
      function _count() {
        ++count;
      }
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('detaching', _count);
        p.on('detached', function() {
          _count();
          bus.disconnect();
        });
        p.on('attaching', _count);
        p.on('attached', function() {
          _count();
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('detaching', _count);
          c.on('detached', function() {
            _count();
            p.detach();
          });
          c.on('attaching', _count);
          c.on('attached', function() {
            _count();
            c.detach();
          });
          c.attach();
        });
        p.attach();
      });
      bus.on('offline', function() {
        count.should.be.exactly(8);
        done();
      });
      bus.connect();
    });

    describe('pushing and consuming messages', function() {

      it('producer attach -> producer push -> consumer attach -> consumer receive', function(done) {
        var testMessage = 'test message';
        var consumed = 0;
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('detached', function() {
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              message.should.be.exactly(testMessage);
              ++consumed;
              c.detach();
            });
            c.on('detached', function() {
              bus.disconnect();
            });
            c.on('attached', function() {
              // wait for messages
              c.consume();
            });
            c.attach();
          });
          p.on('attached', function() {
            // push a message
            p.push(testMessage);
            p.detach();
          });
          p.attach();
        });
        bus.on('offline', function() {
          consumed.should.be.exactly(1);
          done();
        });
        bus.connect();
      });

      it('producer attach -> consumer attach -> producer push -> consumer receive', function(done) {
        var testMessage = 'test message';
        var consumed = 0;
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('attached', function() {
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              message.should.be.exactly(testMessage);
              ++consumed;
              p.detach();
              c.detach();
            });
            c.on('detached', function() {
              bus.disconnect();
            });
            c.on('attached', function() {
              // wait for messages
              c.consume();
              // push a messages
              p.push(testMessage)
            });
            c.attach();
          });
          p.attach();
        });
        bus.on('offline', function() {
          consumed.should.be.exactly(1);
          done();
        });
        bus.connect();
      });

      it('consumer attach -> producer attach -> producer push -> consumer receive', function(done) {
        var testMessage = 'test message';
        var consumed = 0;
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create consumer
          var p;
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('message', function(message) {
            message.should.be.exactly(testMessage);
            ++consumed;
            c.detach();
            p.detach();
          });
          c.on('attached', function() {
            // wait for messages
            c.consume();
            // create producer
            p = bus.queue(qName);
            p.on('error', done);
            p.on('detached', function() {
              bus.disconnect();
            });
            p.on('attached', function() {
              // push a messages
              p.push(testMessage)
            });
            p.attach();
          });
          c.attach();

        });
        bus.on('offline', function() {
          consumed.should.be.exactly(1);
          done();
        });
        bus.connect();
      });

      it('producer attach -> producer push(5) -> consumer attach -> consumer receive(5)', function(done) {
        var testMessage = 'test message';
        var consumed = 0;
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('detached', function() {
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              message.should.be.exactly(testMessage);
              if (++consumed === 5) {
                c.detach();
              }
            });
            c.on('detached', function() {
              bus.disconnect();
            });
            c.on('attached', function() {
              // wait for messages
              c.consume();
            });
            c.attach();
          });
          p.on('attached', function() {
            // push 5 message
            for (var i = 0; i < 5; ++i) {
              p.push(testMessage);
            }
            p.detach();
          });
          p.attach();
        });
        bus.on('offline', function() {
          consumed.should.be.exactly(5);
          done();
        });
        bus.connect();
      });

      it('producer push(5) -> producer attach -> consumer attach -> consumer receive(5)', function(done) {
        var testMessage = 'test message';
        var consumed = 0;
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('detached', function() {
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              message.should.be.exactly(testMessage);
              if (++consumed === 5) {
                c.detach();
              }
            });
            c.on('detached', function() {
              bus.disconnect();
            });
            c.consume();
            c.attach();
          });
          p.on('attached', function() {
            p.detach();
          });
          // push 5 message
          for (var i = 0; i < 5; ++i) {
            p.push(testMessage);
          }
          // attach
          p.attach();
        });
        bus.on('offline', function() {
          consumed.should.be.exactly(5);
          done();
        });
        bus.connect();
      });

      it('queue should not expire if detaching and re-attaching before queue ttl passes', function(done) {
        var testMessage = 'test message';
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('detached', function() {
            setTimeout(function() {
              // ttl is 2 seconds, we re-attach after 1 second
              p.exists(function(exists) {
                exists.should.be.exactly(true);
                bus.disconnect();
              });
            }, 1000);
          });
          p.on('attached', function() {
            p.push(testMessage);
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              done('message should not have been received')
            });
            c.on('attached', function() {
              c.detach();
              p.detach();
            });
            c.attach();
          });
          p.attach({ttl: 5});
        });
        bus.on('offline', function() {
          done();
        });
        bus.connect();
      });

      it('queue should expire: producer attach -> consumer attach -> producer push -> detach all', function(done) {
        var testMessage = 'test message';
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var qName = 'test'+Math.random();
          // create producer
          var p = bus.queue(qName);
          p.on('error', done);
          p.on('detached', function() {

          });
          p.on('attached', function() {
            p.push(testMessage);
            var c = bus.queue(qName);
            c.on('error', done);
            c.on('message', function(message) {
              done('message should not have been received')
            });
            c.on('detached', function() {
              // ttl is 1 second, so the queue must be expired after 1.5 seconds
              setTimeout(function() {
                c.exists(function(exists) {
                  exists.should.be.exactly(false);
                  bus.disconnect();
                });
              }, 1500);
            });
            c.on('attached', function() {
              c.detach();
              p.detach();
            });
            c.attach();
          });
          p.attach({ttl: 1});
        });
        bus.on('offline', function() {
          done();
        });
        bus.connect();
      });

      function testManyMessages(messages, queues, done) {
        var bus = Bus.create({redis: redisUrls, logger: console});
        bus.on('error', done);
        bus.on('online', function() {
          var time = process.hrtime();
          produceAndConsume(bus, messages, queues, function(err) {
            if (err) {
              done(err);
              return;
            }
            var diff = process.hrtime(time);
            console.log('produces and consumes '+messages+' messages in '+queues+' queues took %d milliseconds', (diff[0] * 1e9 + diff[1]) / 1000000);
            bus.disconnect();
          });
        });
        bus.on('offline', function() {
          done();
        });
        bus.connect();
      }

      it('produces and consumes 10 messages in 10 queues', function(done) {
        testManyMessages(10, 10, done);
      });

      it('produces and consumes 100 messages in 10 queues', function(done) {
        testManyMessages(100, 10, done);
      });

      it('produces and consumes 100 messages in 100 queues', function(done) {
        testManyMessages(100, 100, done);
      });

    });

    it('consume max', function(done) {
      var testMessage = 'test message';
      var consumed = 0;
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('detached', function() {
          bus.disconnect();
        });
        p.on('attached', function() {
          p.push(testMessage);
          p.push(testMessage);
          p.push(testMessage);
          p.push(testMessage);
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('message', function(message) {
            message.should.be.exactly(testMessage);
            ++consumed;
          });
          c.on('detached', function() {
            p.detach();
          });
          c.on('consuming', function(status) {
            if (consumed === 0 || consumed === 3) {
              status.should.be.exactly(true);
              c.isConsuming().should.be.exactly(true);
            }
            if (consumed === 2) {
              status.should.be.exactly(false);
              c.isConsuming().should.be.exactly(false);
              consumed = 3;
              c.consume({max: 1});// consume only 1
            }
            if (consumed === 4) {
              status.should.be.exactly(false);
              c.isConsuming().should.be.exactly(false);
              c.detach();
            }
          });
          c.on('attached', function() {
            c.consume({max: 2}); // consume only 2
          });
          c.attach();
        });
        p.attach({ttl: 100});
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('consume without removing', function(done) {
      var testMessage = 'test message';
      var consumed = 0;
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('detached', function() {
          bus.disconnect();
        });
        p.on('attached', function() {
          p.push(testMessage+0);
          p.push(testMessage+1);
          p.push(testMessage+2);
          p.push(testMessage+3);
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('message', function(message) {
            message.should.be.exactly(testMessage+consumed);
            ++consumed;
            if (consumed === 4) {
              var c2 = bus.queue(qName);
              c2.on('error', done);
              c2.on('message', function(message) {
                message.should.be.exactly(testMessage+consumed);
                ++consumed;
                if (consumed === 4) {
                  c2.detach();
                }
              });
              c2.on('detached', function() {
                c.detach();
              });
              c2.on('attached', function() {
                consumed = 0;
                c2.consume();
              });
              c2.attach();
            }
          });
          c.on('detached', function() {
            p.detach();
          });
          c.on('attached', function() {
            c.consume({remove: false}); // do not remove consumed messages
          });
          c.attach();
        });
        p.attach({ttl: 100});
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('flush messages', function(done) {
      var testMessage = 'test message';
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('detached', function() {
          var q = bus.queue(qName);
          q.on('error', done);
          q.on('attached', function(exists) {
            exists.should.be.exactly(true);
            q.count(function(count) {
              count.should.be.exactly(0);
              q.detach();
            });
          });
          q.on('detached', function() {
            bus.disconnect();
          });
          q.attach();
        });
        p.on('attached', function() {
          p.push(testMessage);
          p.push(testMessage);
          p.push(testMessage);
          setImmediate(function() {p.detach();p.flush();});
        });
        p.attach({ttl: 1});
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('should not receive additional messages if stop was called', function(done) {
      var consumed = 0;
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('attached', function() {
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('attached', function(exists) {
            exists.should.be.exactly(true);
          });
          c.on('message', function(message, id) {
            ++consumed;
            message.should.be.exactly('1');
            c.stop();
          });
          c.on('consuming', function(state) {
            state.should.be.exactly(consumed === 0);
            if (!state) {
              c.detach();
            }
          });
          c.on('detached', function() {
            p.detach();
            bus.disconnect();
          });
          c.attach();
          c.consume();
        });
        p.attach({ttl: 1});
        p.push('1');
        p.push('2');
        p.push('3');
      });
      bus.on('offline', function() {
        consumed.should.be.exactly(1);
        done();
      });
      bus.connect();
    });

    it('consume reliable', function(done) {
      var consumed = 0;
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        // create producer
        var p = bus.queue(qName);
        p.on('error', done);
        p.on('detached', function() {
          bus.disconnect();
        });
        p.on('attached', function() {
          p.push('1');
          p.push('2');
          p.push('3');
          p.push('4');
          p.push('5');
          var firstConsume = true;
          var lastMessage;
          var c = bus.queue(qName);
          c.on('error', done);
          c.on('message', function(message, id) {
            ++consumed;
            lastMessage = message;
            // ack the first and second messages
            if (message === '1' || message === '2') {
              consumed.should.be.exactly(parseInt(message));
              id.should.be.exactly(consumed);
              c.ack(id);
            }
            // we should be getting the 3rd message twice - the first time without ackin it
            // and the second time because we didn't ack it the first time
            if (message === '3') {
              // do not ack the 3rd message the first time around
              if (firstConsume) {
                consumed.should.be.exactly(3);
                id.should.be.exactly(3);
                c.stop();
                firstConsume = false;
              } else {
                consumed.should.be.exactly(4);
                id.should.be.exactly(3);
                c.ack(id);
              }
            }
            if (message === '4') {
              consumed.should.be.exactly(5);
              id.should.be.exactly(4);
              // stop consuming again and ack the message when starting to consume again
              c.stop();
            }
            if (message === '5') {
              consumed.should.be.exactly(6);
              id.should.be.exactly(5);
              c.ack(id);
              // we're done
              c.detach();
            }
          });
          c.on('detached', function() {
            p.detach();
          });
          c.on('consuming', function(status) {
            if (consumed === 0) {
              status.should.be.exactly(true);
            }
            if (consumed === 3) {
              lastMessage.should.be.exactly('3');
              if (status === false) {
                // start consuming again
                c.consume({reliable: true});
              }
            }
            if (consumed === 5) {
              lastMessage.should.be.exactly('4');
              if (status === false) {
                // start consuming again and specify the last acked message
                c.consume({reliable: true, last: 4});
              }
            }
            if (consumed === 6) {
              lastMessage.should.be.exactly('5');
              status.should.be.exactly(false);
            }
          });
          c.on('attached', function() {
            c.consume({reliable: true});
          });
          c.attach();
        });
        p.attach({ttl: 100});
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('should set and get arbitrary metadata', function(done) {
      var key1 = 'key1';
      var value1 = 'value1';
      var key2 = 'key2';
      var value2 = 'value2';
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var qName = 'test'+Math.random();
        var q = bus.queue(qName);
        q.on('error', done);
        q.on('detached', function() {
          bus.disconnect();
        });
        q.on('attached', function() {
          q.metadata(key1, value1, function() {
            q.metadata(key2, value2, function() {
              q.metadata(key1, function(val1) {
                val1.should.be.exactly(value1);
                q.metadata(key2, function(val2) {
                  val2.should.be.exactly(value2);
                  q.detach();
                });
              });
            });
          });
        });
        q.attach({ttl: 1});
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

  });

  describe('channels', function() {

    it('server listens -> client connects', function(done) {
      var testMessage = 'test message';
      var sEvents = {'message': 0};
      var cEvents = {'message': 0};
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var cName = 'test'+Math.random();
        var cServer = bus.channel(cName);
        var cClient = bus.channel(cName);
        cServer.on('error', function(error) {
          sEvents['error'] = error;
          bus.disconnect();
        });
        cServer.on('connect', function() {
          sEvents['connect'] = true;
          cClient.on('error', function(error) {
            cEvents['error'] = error;
            bus.disconnect();
          });
          cClient.on('connect', function() {
            cEvents['connect'] = true;
          });
          cClient.on('remote:connect', function() {
            cEvents['remote:connect'] = true;
            cClient.send(testMessage);
          });
          cClient.on('message', function(message) {
            message.should.be.exactly(testMessage);
            if (++cEvents['message'] < 5) {
              cClient.send(testMessage);
            } else {
              cClient.end();
            }
          });
          cClient.on('end', function() {
            cEvents['end'] = true;
          });
          cClient.connect();
        });
        cServer.on('remote:connect', function() {
          sEvents['remote:connect'] = true;
        });
        cServer.on('message', function(message) {
          message.should.be.exactly(testMessage);
          ++sEvents['message'];
          cServer.send(testMessage);
        });
        cServer.on('end', function() {
          sEvents['end'] = true;
          bus.disconnect();
        });
        cServer.listen();
      });
      bus.on('offline', function() {
        Should(sEvents['connect']).equal(true);
        Should(sEvents['remote:connect']).equal(true);
        Should(sEvents['message']).equal(5);
        Should(sEvents['end']).equal(true);
        Should(sEvents['error']).equal(undefined);

        Should(cEvents['connect']).equal(true);
        Should(cEvents['remote:connect']).equal(true);
        Should(cEvents['message']).equal(5);
        Should(cEvents['end']).equal(undefined);
        Should(cEvents['error']).equal(undefined);

        done();
      });
      bus.connect();
    });

    it('client connects -> server listens', function(done) {
      var testMessage = 'test message';
      var sEvents = {'message': 0};
      var cEvents = {'message': 0};
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var cName = 'test'+Math.random();
        var cServer = bus.channel(cName);
        var cClient = bus.channel(cName);
        cClient.on('error', function(error) {
          cEvents['error'] = error;
          bus.disconnect();
        });
        cClient.on('connect', function() {
          cEvents['connect'] = true;
          cServer.on('error', function(error) {
            sEvents['error'] = error;
            bus.disconnect();
          });
          cServer.on('connect', function() {
            sEvents['connect'] = true;
          });
          cServer.on('remote:connect', function() {
            sEvents['remote:connect'] = true;
            cServer.send(testMessage);
          });
          cServer.on('message', function(message) {
            message.should.be.exactly(testMessage);
            if (++sEvents['message'] < 5) {
              cServer.send(testMessage);
            } else {
              cServer.end();
            }
          });
          cServer.on('end', function() {
            sEvents['end'] = true;
          });
          cServer.listen();
        });
        cClient.on('remote:connect', function() {
          cEvents['remote:connect'] = true;
        });
        cClient.on('message', function(message) {
          message.should.be.exactly(testMessage);
          ++cEvents['message'];
          cClient.send(testMessage);
        });
        cClient.on('end', function() {
          cEvents['end'] = true;
          bus.disconnect();
        });
        cClient.connect();
      });
      bus.on('offline', function() {
        Should(sEvents['connect']).equal(true);
        Should(sEvents['remote:connect']).equal(true);
        Should(sEvents['message']).equal(5);
        Should(sEvents['end']).equal(undefined);
        Should(sEvents['error']).equal(undefined);

        Should(cEvents['connect']).equal(true);
        Should(cEvents['remote:connect']).equal(true);
        Should(cEvents['message']).equal(5);
        Should(cEvents['end']).equal(true);
        Should(cEvents['error']).equal(undefined);

        done();
      });
      bus.connect();
    });

    it('reliable channel', function(done) {
      var sEvents = {msg: 0};
      var cEvents = {msg: 0};
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var cName = 'test'+Math.random();
        var cServer = bus.channel(cName);
        var cClient = bus.channel(cName);
        cServer.on('error', function(error) {
          sEvents['error'] = error;
          bus.disconnect();
        });
        cServer.on('connect', function() {
          sEvents['connect'] = true;
          cClient.on('error', function(error) {
            cEvents['error'] = error;
            bus.disconnect();
          });
          cClient.on('connect', function() {
            cEvents['connect'] = true;
          });
          cClient.on('remote:connect', function() {
            cEvents['remote:connect'] = true;
            cClient.send(++cEvents.msg);
          });
          cClient.on('disconnect', function() {
            // connect again to the channel, we should start getting messages again
            cClient.connect({reliable: true});
          });
          cClient.on('message', function(message, id) {
            // count the number of times a message was received
            cEvents[message] = cEvents[message] || 0;
            ++cEvents[message];
            if (parseInt(message) < 5) {
              if (message === '3' && cEvents[message] === 1) {
                // disconnect without acking the message.
                // we expect to get it again when we connect again
                cClient.disconnect();
              } else {
                cClient.send(++cEvents.msg);
                cClient.ack(id);
              }
            } else {
              cClient.end();
            }
          });
          cClient.on('end', function() {
            cEvents['end'] = true;
          });
          cClient.connect({reliable: true});
        });
        cServer.on('remote:connect', function() {
          sEvents['remote:connect'] = true;
        });
        cServer.on('message', function(message) {
          message.should.be.exactly((++sEvents.msg)+'');
          cServer.send(sEvents.msg);
        });
        cServer.on('end', function() {
          sEvents['end'] = true;
          bus.disconnect();
        });
        cServer.listen({reliable: true});
      });
      bus.on('offline', function() {
        Should(sEvents['connect']).equal(true);
        Should(sEvents['remote:connect']).equal(true);
        Should(sEvents.msg).equal(5);
        Should(sEvents['end']).equal(true);
        Should(sEvents['error']).equal(undefined);

        Should(cEvents['connect']).equal(true);
        Should(cEvents['remote:connect']).equal(true);
        Should(cEvents['1']).equal(1);
        Should(cEvents['2']).equal(1);
        Should(cEvents['3']).equal(2);
        Should(cEvents['4']).equal(1);
        Should(cEvents['5']).equal(1);
        Should(cEvents['end']).equal(undefined);
        Should(cEvents['error']).equal(undefined);

        done();
      });
      bus.connect();
    });
  });

  describe('persistency', function() {

    it('saves and loads an object', function(done) {
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        var object = bus.persistify('data1', {}, ['field1', 'field2', 'field3']);
        object.field1 = 'val1';
        object.field2 = 2;
        object.field3 = true;
        object.save(function(err) {
          Should(err).equal(undefined);
          object.field1 = 'val2';
          object.save(function(err) {
            Should(err).equal(undefined);
            var object2 = bus.persistify('data1', {}, ['field1', 'field2', 'field3']);
            object2.load(function(err, exists) {
              Should(err).equal(null);
              exists.should.be.exactly(true);
              Should(object2.field1).equal('val2');
              Should(object2.field2).equal(2);
              Should(object2.field3).equal(true);
              bus.disconnect();
            })
          });
        });
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    function testManySavesAndLoades(objects, done) {
      var bus = Bus.create({redis: redisUrls, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        function _done() {
          if (--objects === 0) {
            bus.disconnect();
          }
        }

        for (var iObject = 0; iObject < objects; ++iObject) {
          (function(i) {
            var name = 'data'+i;
            var object = bus.persistify(name, {}, ['field1', 'field2', 'field3']);
            object.field1 = 'val'+i;
            object.field2 = 2;
            object.field3 = true;
            object.save(function(err) {
              Should(err).equal(undefined);
              object.field1 = 'val2'+i;
              object.save(function(err) {
                Should(err).equal(undefined);
                var object2 = bus.persistify(name, {}, ['field1', 'field2', 'field3']);
                object2.load(function(err, exists) {
                  Should(err).equal(null);
                  exists.should.be.exactly(true);
                  Should(object2.field1).equal('val2'+i);
                  Should(object2.field2).equal(2);
                  Should(object2.field3).equal(true);
                  _done();
                })
              });
            });
          })(iObject);
        }
      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    }

    it('persists 10 objects', function(done) {
      testManySavesAndLoades(10, done);
    });

    it('persists 100 objects', function(done) {
      testManySavesAndLoades(100, done);
    });

    it('persists 1000 objects', function(done) {
      testManySavesAndLoades(1000, done);
    });
  });

  describe('federation', function() {

    beforeEach(function(done) {
      fedserver = http.createServer();
      fedserver.listen(9777);
      done();
    });

    afterEach(function(done) {
      fedserver.close();
      done();
    });

    it('federates queue events', function(done) {

      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver, path: '/federate'}, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777/federate'], poolSize: 5 }});
        busFed.on('error', function(err) {
          done(err);
        });
        busFed.on('online', function() {
          var msgs = [];
          var name = 'q'+Date.now();
          var f = busFed.federate(busFed.queue(name), 'http://127.0.0.1:9777/federate');
          f.on('error', done);
          f.on('unauthorized', function() {
            done('unauthorized')
          });
          f.on('ready', function(q) {
            q.on('error', done);
            q.on('attached', function() {
              q.consume();
            });
            q.on('consuming', function(state) {
              if (state) {
                q.push('hello');
                q.push('world');
              } else {
                q.detach();
              }
            });
            q.on('message', function(msg) {
              msgs.push(msg);
              if (msgs.length === 2) {
                q.stop();
              }
            });
            q.on('detached', function() {
              msgs.length.should.be.exactly(2);
              msgs[0].should.be.exactly('hello');
              msgs[1].should.be.exactly('world');
              f.close();
            });
            q.attach();
          });
          f.on('close', function() {
            busFed.disconnect();
          });
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();

      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('federates channel events', function(done) {
      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver}, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777'], poolSize: 5 }});
        busFed.on('error', function(err) {
          done(err);
        });
        busFed.on('online', function() {
          var name = 'q'+Date.now();
          var f = busFed.federate(busFed.channel(name, 'local', 'remote'), 'http://127.0.0.1:9777');
          f.on('error', done);
          f.on('unauthorized', function() {
            done('unauthorized')
          });
          f.on('ready', function(c) {
            c.on('error', done);
            c.on('remote:connect', function() {
              c.send('hello');
            });
            c.on('message', function(message) {
              message.should.be.exactly('world');
              c.disconnect();
              f.close();
            });
            c.connect();
          });
          f.on('close', function() {
            busFed.disconnect();
          });

          var c2 = busFed.channel(name, 'remote', 'local');
          c2.on('error', done);
          c2.on('remote:connect', function() {
          });
          c2.on('message', function(message) {
            message.should.be.exactly('hello');
            c2.send('world');
          });
          c2.on('remote:disconnect', function() {
            c2.disconnect();
          });
          c2.connect();
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();

      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('federates persisted objects', function(done) {
      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver}, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777'], poolSize: 5 }});
        busFed.on('error', function(err) {
          done(err);
        });
        busFed.on('online', function() {
          var f = busFed.federate(busFed.persistify('p1', {}, ['f1', 'f2', 'f3']), 'http://127.0.0.1:9777');
          f.on('error', done);
          f.on('unauthorized', function() {
            done('unauthorized')
          });
          f.on('ready', function(p) {
            p.f1 = 'v1';
            p.f2 = 2;
            p.f3 = true;
            p.save(function(err) {
              Should(err).equal(undefined);
              p.f1 = 'v2';
              p.save(function(err) {
                Should(err).equal(undefined);
                var f2 = busFed.federate(busFed.persistify('p1', {}, ['f1', 'f2', 'f3']), 'http://127.0.0.1:9777');
                f2.on('error', done);
                f2.on('unauthorized', function() {
                  done('unauthorized')
                });
                f2.on('ready', function(p) {
                  p.load(function(err, exist) {
                    Should(err).equal(null);
                    Should(exist).equal(true);
                    Should(p.f1).equal('v2');
                    Should(p.f2).equal(2);
                    Should(p.f3).equal(true);
                    f2.close();
                  });
                });
                f2.on('close', function() {
                  f.close();
                });
              });
            });
          });
          f.on('close', function() {
            busFed.disconnect();
          });
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();

      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    it('does not allow federation with wrong secret', function(done) {
      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver, secret: 'thisisit'}, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777'], poolSize: 5, secret: 'thisisNOTit' }});
        busFed.on('error', function(err) {
          done(err);
        });
        busFed.on('online', function() {
          var name = 'q'+Date.now();
          var f = busFed.federate(busFed.queue(name), 'http://127.0.0.1:9777');
          f.on('error', done);
          f.on('unauthorized', function() {
            busFed.disconnect();
          });
          f.on('ready', function() {
            done('ready should not have been called')
          });
          f.on('close', function() {
          });
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();

      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    });

    function testManyMessagesOverFederation(messages, queues, done) {
      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver, path: '/federate'}, logger: console});
      bus.on('error', function(err) {
        done(err);
      });
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777/federate'], poolSize: 10 }});
        busFed.on('error', function(err) {
          done(err);
        });
        busFed.on('online', function() {
          var time = process.hrtime();
          produceAndConsumeOverFederation(busFed, bus, 'http://127.0.0.1:9777/federate', messages, queues, function(err) {
            if (err) {
              done(err);
              return;
            }
            var diff = process.hrtime(time);
            console.log('produces and consumes '+messages+' messages in '+queues+' queues over federation took %d milliseconds', (diff[0] * 1e9 + diff[1]) / 1000000);
            busFed.disconnect();
          });
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();

      });
      bus.on('offline', function() {
        done();
      });
      bus.connect();
    }

    it('produces and consumes 10 messages in 10 queues over federation', function(done) {
      testManyMessagesOverFederation(10, 10, done);
    });

    it('produces and consumes 100 messages in 10 queues over federation', function(done) {
      testManyMessagesOverFederation(100, 10, done);
    });

    it('produces and consumes 100 messages in 100 queues over federation', function(done) {
      testManyMessagesOverFederation(100, 100, done);
    });

    function testManySavesAndLoadesOverFederation(objects, done) {
      var total = objects;
      var bus = Bus.create({redis: redisUrls, federate: {server: fedserver, path: '/federate'}, logger: console});
      bus.on('error', done);
      bus.on('online', function() {
        // create a second bus to federate requests
        var busFed = Bus.create({redis: redisUrls, logger: console, federate: {urls: ['http://127.0.0.1:9777/federate'], poolSize: objects/2 }});
        busFed.on('error', done);
        busFed.on('online', function() {

          var time = process.hrtime();
          function _done() {
            if (--objects === 0) {
              var diff = process.hrtime(time);
              console.log('persist ' + total +' objects over federation took %d milliseconds', (diff[0] * 1e9 + diff[1]) / 1000000);
              busFed.disconnect();
            }
          }

          for (var iObject = 0; iObject < objects; ++iObject) {
            (function(i) {
              var name = 'data'+i;
              var object = bus.persistify(name, {}, ['field1', 'field2', 'field3']);
              object.field1 = 'val'+i;
              object.field2 = 2;
              object.field3 = true;
              object.save(function(err) {
                Should(err).equal(undefined);
                var fedObj = busFed.federate(busFed.persistify(name, {}, ['field1', 'field2', 'field3']), 'http://127.0.0.1:9777/federate');
                fedObj.on('ready', function(obj) {
                  obj.load(function(err, exists) {
                    Should(err).equal(null);
                    exists.should.be.exactly(true);
                    Should(obj.field1).equal('val'+i);
                    Should(obj.field2).equal(2);
                    Should(obj.field3).equal(true);
                    fedObj.close();
                  });
                });
                fedObj.on('error', done);
                fedObj.on('close', function() {
                  _done();
                });
              });
            })(iObject);
          }
        });
        busFed.on('offline', function() {
          bus.disconnect();
        });
        busFed.connect();
      });

      bus.on('offline', function() {
        done();
      });
      bus.connect();
    }

    it('persists 10 objects over federation', function(done) {
      testManySavesAndLoadesOverFederation(10, done);
    });

    it('persists 100 objects over federation', function(done) {
      testManySavesAndLoadesOverFederation(100, done);
    });

    it('persists 200 objects over federation', function(done) {
      testManySavesAndLoadesOverFederation(200, done);
    });

  });
});