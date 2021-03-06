'use strict';

const log4js = require('log4js');
const logger = log4js.getLogger('system');

const dgram = require('dgram');
// let client = dgram.createSocket('udp4');
let client;

const config = appRequire('services/config').all();
const host = config.shadowsocks.address.split(':')[0];
const port = +config.shadowsocks.address.split(':')[1];

const knex = appRequire('init/knex').knex;

const moment = require('moment');

let shadowsocksType = 'libev';
let lastFlow;

const sendPing = () => {
  client.send(new Buffer('ping'), port, host);
};

const connect = () => {
  client = dgram.createSocket('udp4');
  client.on('message', async (msg, rinfo) => {
    const msgStr = new String(msg);
    if(msgStr.substr(0, 4) === 'pong') {
      shadowsocksType = 'python';
    } else if(msgStr.substr(0, 5) === 'stat:') {
      let flow = JSON.parse(msgStr.substr(5));
      const realFlow = compareWithLastFlow(flow, lastFlow);
      logger.info(`Receive flow from shadowsocks: (${ shadowsocksType })\n${JSON.stringify(realFlow, null, 2)}`);
      lastFlow = flow;
      const insertFlow = Object.keys(realFlow).map(m => {
        return {
          port: +m,
          flow: +realFlow[m],
          time: Date.now(),
        };
      }).filter(f => {
        return f.flow > 0;
      });
      const accounts = await knex('account').select([ 'port' ]);
      insertFlow.forEach(fe => {
        const account = accounts.filter(f => {
          return fe.port === f.port;
        })[0];
        if(!account) {
          sendMessage(`remove: {"server_port": ${ fe.port }}`);
        }
      });
      if(insertFlow.length > 0) {
        knex('flow').insert(insertFlow).then();
      }
    };
  });

  client.on('error', (err) => {
    console.log(`client error:\n${err.stack}`);
  });
  client.on('close', () => {
    console.log(`client close`);
  });
};

const sendMessage = (message) => {
  const randomTraceNumber = Math.random().toString().substr(2,6);
  logger.info(`[${ randomTraceNumber }] Send to shadowsocks: ${ message }`);
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    client.send(message, port, host, (err) => {
      if(err) {
        logger.error(`[${ randomTraceNumber }] Shadowsocks error:\n${err.stack}`);
        return reject('error');
      }
    });
    client.on('message', (msg) => {
      logger.info(`[${ randomTraceNumber }] Receive from shadowsocks: ${ msg.toString() }`);
      client.close();
      resolve('ok');
    });
    client.on('close', () => {
      logger.info(`[${ randomTraceNumber }] Shadowsocks close`);
      return reject('close');
    });
    client.on('error', (err) => {
      logger.error(`[${ randomTraceNumber }] Shadowsocks error:\n${err.stack}`);
    });
  });
};

const startUp = async () => {
  client.send(new Buffer('ping'), port, host);
  if(config.runShadowsocks === 'python') {
    sendMessage(`remove: {"server_port": 65535}`);
  }
  const accounts = await knex('account').select([ 'port', 'password' ]);
  accounts.forEach(f => {
    sendMessage(`add: {"server_port": ${ f.port }, "password": "${ f.password }"}`);
  });
};

const resend = async () => {
  const accounts = await knex('account').select([ 'port', 'password' ]);
  accounts.forEach(f => {
    sendMessage(`add: {"server_port": ${ f.port }, "password": "${ f.password }"}`);
  });
};

const compareWithLastFlow = (flow, lastFlow) => {
  if(shadowsocksType === 'python') {
    return flow;
  }
  const realFlow = {};
  if(!lastFlow) {
    return flow;
  }
  for(const f in flow) {
    if(lastFlow[f]) {
      realFlow[f] = flow[f] - lastFlow[f];
    } else {
      realFlow[f] = flow[f];
    }
  }
  if(Object.keys(realFlow).map(m => realFlow[m]).sort((a, b) => a > b)[0] < 0) {
    // console.log(realFlow);
    return flow;
  }
  return realFlow;
};

connect();
startUp();
setInterval(() => {
  resend();
  sendPing();
}, 60 * 1000);

const checkPortRange = (port) => {
  if(!config.shadowsocks.portRange) { return true; }
  const portRange = config.shadowsocks.portRange.split(',');
  let isInRange = false;
  portRange.forEach(f => {
    if(f.indexOf('-') >= 0) {
      const range = f.trim().split('-');
      if(port >= +range[0] && port <= +range[1]) {
        isInRange = true;
      }
    } else if (port === +f) {
      isInRange = true;
    }
  });
  return isInRange;
};

const addAccount = async (port, password) => {
  try {
    if(!checkPortRange(port)) {
      return Promise.reject('error');
    }
    const insertAccount = await knex('account').insert({
      port,
      password,
    });
    await sendMessage(`add: {"server_port": ${ port }, "password": "${ password }"}`);
    return { port, password };
  } catch(err) {
    return Promise.reject('error');
  }
};

const removeAccount = async (port) => {
  try {
    const deleteAccount = await knex('account').where({
      port,
    }).delete();
    if(deleteAccount <= 0) {
      return Promise.reject('error');
    }
    await knex('flow').where({
      port,
    }).delete();
    await sendMessage(`remove: {"server_port": ${ port }}`);
    return { port };
  } catch(err) {
    return Promise.reject('error');
  }
};

const changePassword = async (port, password) => {
  try {
    const updateAccount = await knex('account').where({port}).update({
      password,
    });
    if(updateAccount <= 0) {
      return Promise.reject('error');
    }
    await sendMessage(`remove: {"server_port": ${ port }}`);
    await sendMessage(`add: {"server_port": ${ port }, "password": "${ password }"}`);
    return { port, password };
  } catch(err) {
    return Promise.reject('error');
  }
};

const listAccount = async () => {
  try {
    const accounts = await knex('account').select([ 'port', 'password' ]);
    return accounts;
  } catch(err) {
    return Promise.reject('error');
  }
};

const getFlow = async (options) => {
  try {
    const startTime = moment(options.startTime || new Date(0)).toDate();
    const endTime = moment(options.endTime || new Date()).toDate();

    const accounts = await knex('account').select([ 'port' ]);
    const flows = await knex('flow').select([ 'port', 'sumFlow' ])
    .sum('flow as sumFlow').groupBy('port')
    .whereBetween('time', [ startTime, endTime ]);

    accounts.map(m => {
      const flow = flows.filter(f => {
        return f.port === m.port;
      })[0];
      if(flow) {
        m.sumFlow = flow.sumFlow;
      } else {
        m.sumFlow = 0;
      }
      return m;
    });
    if(options.clear) {
      await knex('flow').whereBetween('time', [ startTime, endTime ]).delete();
    }
    return accounts;
  } catch(err) {
    console.log(err);
    return Promise.reject('error');
  }
};

exports.addAccount = addAccount;
exports.removeAccount = removeAccount;
exports.changePassword = changePassword;
exports.listAccount = listAccount;
exports.getFlow = getFlow;
