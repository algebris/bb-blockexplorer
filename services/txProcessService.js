const _ = require('lodash');
// const bunyan = require('bunyan');
// const log = bunyan.createLogger({name: 'core.blockProcessor'});
const log = require(`${APP_DIR}/utils/logging`)({name:'txProcessService'});
const db = require(`${SRV_DIR}/database`).redis;
const cfg = require(`${APP_DIR}/config`);

const convertToSatoshi = val => parseInt(parseFloat(val).toFixed(8).toString().replace('.', ''));
const hasValidOuts = val => ['nonstandard', 'nulldata'].indexOf(val.type) == -1;
const groupByAddr = arr => _.chain(arr)
  .groupBy('addr')
  .map((group, key) => ({addr: key, val: _.sumBy(group, 'val')}))
  .value();
  
const normalizeTx = tx => {
  let {vin, vout} = [];
  const {txid, time} = tx;

  const flattenScript = (a, v, k) => {
    if(k == 'scriptPubKey') {
      a = _.merge(a, v);
      if(a.addresses) 
        a.addresses = a.addresses.shift();
    } else 
      a[k] = v;
  };

  vin = _.chain(tx)
    .get('vin', [])
    .transform((acc, tin) => {
      const mapKeys = {
        'txid': 'id',
        'vout': 'n'
      };
      if(tin.coinbase)
        acc.push({addr: 'coinbase', val: 0});

      if(tin.txid && _.isNumber(tin.vout))
        acc.push(
          _.chain(tin)
            .pick(['txid', 'vout'])
            .mapKeys((v, k) => mapKeys[k])
            .value()
          );
    }).value();
  
  vout = _.chain(tx)
    .get('vout', [])
    .transform((acc, out) => {
      const mapKeys = {
        'value': 'val',
        'addresses': 'addr',
        'type': 'type',
        'n':'n'
      };
      acc.push(
        _.chain(out)
          .pick(['value', 'n', 'scriptPubKey.type', 'scriptPubKey.addresses[0]'])
          .transform(flattenScript)
          .mapKeys((v, k) => mapKeys[k])
          .update('val', convertToSatoshi)
          .value()
      );
    }).value();

  return {txid, time, vin, vout};
};

/**
 * Processing INS
 * @param {array} tx Transaction's object
 * @param {number} height Height of blocks
 * @param {boolean} shouldUpdate
 */
const processIns = async (tx, height, shouldUpdate) => {
  let result = [];
  const summarize = (result, out) => _.add(result, out.val);

  for (const vin of tx.vin) {
    if(vin.addr == 'coinbase') {
      const val = _.chain(tx.vout)
        .filter(hasValidOuts)
        .reduce(summarize, 0)
        .value();
      result.push({addr: 'coinbase', val});
    } else {
      let fout = await db.client.hget(`utxo:${vin.id}:${vin.n}`, 'json');
      if(fout !== null) {
        let utxo;
        try {
          utxo = JSON.parse(fout);
        } catch(err) {
          log.error(`Error parsing utxo:${vin.id}:${vin.n}, json =${fout}`);
        }
        if(utxo && shouldUpdate)
          await db.client.pipeline()
            .hdel(`utxo:${vin.id}:${vin.n}`)
            .lrem(`addr.utxo:${utxo.addr}`, 0, `${vin.id}:${vin.n}`)
            // .zadd(`addr.txs:${utxo.addr}`, height, `${vin.id}:${vin.n}`)
            .exec();
        if(utxo)
          result.push(_.pick(utxo, ['addr', 'val']));
      } else {
        log.error(`DB missed TX [txId=utxo:${vin.id}:${vin.n}]`);
      }
    }
  }
  // console.log({result});
  return groupByAddr(result);
};

/**
 * Processing OUTS
 * @param {array} tx Transaction's object
 * @param {array} vin Processed input object
 * @param {boolean} shouldUpdate
 */
const processOuts = async (tx, vin, height, shouldUpdate) => {
  let result = [];
  let nvin = Array.from(vin);
  let staked = false;

  for (const vout of tx.vout) {
    let pair = _.pick(vout, ['addr', 'val']) || {};
    if(hasValidOuts(vout) && _.keys(pair).length == 2) {
      if(shouldUpdate) {
        pair = _.assign(pair, {txid:tx.txid, height, n:vout.n, time:tx.time});
        await db.client.pipeline()
          .hmset(`utxo:${tx.txid}:${vout.n}`, _.assign(pair, {json: JSON.stringify(pair)}))
          .rpush(`addr.utxo:${vout.addr}`, `${tx.txid}:${vout.n}`)
          .exec();
      }
      result.push(pair);
    }
    // console.log({result, nvin});
    result = groupByAddr(result);
  }
  if(tx.vout[0].type == 'nonstandard' && result.length > 0 && nvin.length > 0 && nvin[0].addr == result[0].addr) {
    result[0].val -= nvin[0].val;
    nvin.shift();
    staked = true;
  }
  return {vout: result, nvin, staked};
};

/**
 * Update account's balances
 * @param {object} args arguments {addr, amount, type}
 */
const updateAddress = async args => {
  const {addr, val, type, txid, isStaked} = args;
  if ( addr == 'coinbase' ) {
    return await db.client.hincrby('coinbase', 'sent', val);
  }
  let [sent, received, staked] = await db.client.hmget(`addr:${addr}`, ['sent', 'received', 'staked']);
  sent = parseInt(sent) || 0;
  received = parseInt(received) || 0;
  staked = parseInt(staked) || 0;

  if (type == 'vin' && !isStaked)
    sent += val;
  else if (type == 'vout' && !isStaked)
    received += val;
  else if (type == 'vout' && isStaked)
    staked += val;

  const balance = received + staked - sent;
  const result = {sent, received, staked, balance};

  await db.client.hmset(`addr:${addr}`, result);
  
  if(type == 'vin')
    await db.client.rpush(`addr.sent:${addr}`, txid);

  if(type == 'vout' && !isStaked) {
    await db.client.rpush(`addr.received:${addr}`, txid);
  }
  if(type == 'vout' && isStaked) {
    await db.client.rpush(`addr.staked:${addr}`, txid);
  }
  return _.assign(result, {val});
};

module.exports = {
  convertToSatoshi,
  updateAddress,
  normalizeTx,
  processIns,
  processOuts
};