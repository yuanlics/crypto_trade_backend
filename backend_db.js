const {MongoClient, Double} = require('mongodb');
const {InfluxDB} = require('@influxdata/influxdb-client');
require('dotenv').config({ path: './config/.env' });

const { MONGODB_URL, MONGODB_USERNAME, MONGODB_PWD, INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG } = process.env;

const mongodb_uri = `mongodb://${MONGODB_USERNAME}:${MONGODB_PWD}@${MONGODB_URL}/?maxPoolSize=20&w=majority`;
const mongodb_client = new MongoClient(mongodb_uri);
const mongodb_db = "currency"
const mongodb_collection = "test";  // DEBUG

const queryApi = new InfluxDB({'url': INFLUXDB_URL, 'token': INFLUXDB_TOKEN}).getQueryApi(INFLUXDB_ORG)


async function getSchemeAccount(username, schemeId, chainName) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    const projection = {'username': 1, 'schemes': {'id': 1, 'chainAddresses': 1}};
    const user = await users_collection.findOne({"username": username, "schemes.id": schemeId}, projection);
    var result = null;
    for (const scheme of user.schemes) {
        if (scheme.id == schemeId) {
            const arr = scheme.chainAddresses.filter(obj => (obj['name'].indexOf(chainName) != -1));
            if (arr.length > 0) {
                result = {'address': arr[0].address, 'privateKey': arr[0].privateKey};
            }
            break;
        }
    }
    await mongodb_client.close();
    return result;
}


async function setSchemeAccount(username, schemeId, chainName, account) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    const chainAddr = {
        "name": chainName,
        "address": account.address,
        "privateKey": account.privateKey
    }
    await users_collection.updateOne({"username": username, "schemes.id": schemeId}, 
                {'$push': {["schemes.$.chainAddresses"]: chainAddr}});
    await mongodb_client.close();
}


async function getExchangeRate() {
    const query = `from (bucket: "Klines") |> range(start: -15m)
    |> filter(fn: (r) => r["_measurement"] == "BTC_USDT" 
    or r["_measurement"] == "ETH_USDT" or r["_measurement"] == "BNB_USDT" 
    or r["_measurement"] == "SOL_USDT" or r["_measurement"] == "ADA_USDT" 
    or r["_measurement"] == "XRP_USDT" or r["_measurement"] == "DOT_USDT" 
    or r["_measurement"] == "DOGE_USDT" or r["_measurement"] == "AVAX_USDT" 
    or r["_measurement"] == "DAI_USDT"
    or r["_measurement"] == "SHIB_USDT" or r["_measurement"] == "LUNA_USDT")
    |> filter(fn: (r) => r["_field"] == "high" or r["_field"] == "low" or r["_field"] == "volume")
    |> last()
    |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")`
    var tables = await queryApi.collectRows(query)
    var prices = {}
    var P, Q, time
    tables.forEach((o) => {
        var p = (o.high + o.low) / 2
        var q = o.volume
        time = o._time
        const tokenName = o._measurement.replace('_USDT', '')
        if (tokenName in prices) {
            P += p * q
            Q += q
        } else {
            P = p * q
            Q = q
        }
        if (Q != 0) {
            prices[tokenName] = P / Q
        } else {
            prices[tokenName] = 0
        }
    })
    prices['USDT'] = 1.0
    prices['USDC'] = 1.0
    prices['WBNB'] = prices['BNB']
    data = {'prices': prices, "time": time}
    return data
}


// Currently only support BSC
async function setProperties(username, schemeId, balances) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);

    const obj = await users_collection.findOne({"username": username, "schemes.id": schemeId},
                                                    {projection: {"schemes.$": 1, '_id': 0}})
    const properties_old = obj.schemes[0].properties

    var balances_proc = {};
    for (var [tokenName, balance] of Object.entries(balances)) {
        tokenName = tokenName.replace('bep20_', '').toUpperCase();
        balances_proc[tokenName] = balance;
    }
    balances = balances_proc;

    keys_old = properties_old.map(obj => (obj.symbol));
    keys_new = Object.keys(balances);
    keys_to_insert = keys_new.filter(x => !keys_old.includes(x));

    // if (schemeId == 2) {
    //     console.log('balances:', balances);
    //     console.log('keys_old:', keys_old);
    //     console.log('keys_new:', keys_new);
    //     console.log('keys_to_insert:', keys_to_insert);
    // }

    var properties_new = [];
    for (var token of properties_old) {
        tokenName = token.symbol;
        if (keys_new.includes(tokenName)) {
            balance = balances[tokenName];
            const token_addrs_new = token.addresses.map(obj => {
                if (obj.chain == 'BEP20 (BSC)') {
                    obj.amount = balance;
                    obj.update_time = new Date();
                }
                obj.amount = Double(obj.amount);
                obj.withdrawAmount = Double(obj.withdrawAmount);
                return obj
            });
            token.addresses = token_addrs_new;
            properties_new.push(token);
        } else {
            const token_addrs_new = token.addresses.map(obj => {
                obj.amount = Double(obj.amount);
                obj.withdrawAmount = Double(obj.withdrawAmount);
                return obj;
            });
            token.addresses = token_addrs_new;
            properties_new.push(token);
        }
    }

    for (const tokenName of keys_to_insert) {
        var token = {
            "symbol": tokenName,
            "addresses": [
                {
                    "chain": "BEP20 (BSC)",
                    "amount": Double(balances[tokenName]),
                    "withdrawAmount": Double(0),
                    "books": [ ],
                    "update_time": new Date()
                }
            ]
        }
        properties_new.push(token);
    }

    // if (schemeId == 2) {
    //     console.log('properties_new:', JSON.stringify(properties_new, null, 4));
    // }

    await users_collection.updateOne({"username": username, "schemes.id": schemeId}, 
                                    {'$set': {["schemes.$.properties"]: properties_new}})

    await mongodb_client.close();
}


// First Update properties according to existing tokens. 
// (Token entries are added when creating account, so only balances need to be updated here. )
// Then update property logs according to the latest properties and exchange rate.
async function updatePropertyLog() {
    const rate = await getExchangeRate();

    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    const projection = {'username': 1, 'schemes': {'id': 1, 'properties': 1, 'propertyLogs': 1}};
    const users = await users_collection.find().project(projection).toArray();
    for (const user of users) {
        for (const scheme of user.schemes) {
            var balance = 0;
            for (const token of scheme.properties) {
                const amount = token.addresses.reduce((x, y) => {return {amount: x.amount + y.amount}}).amount
                balance += amount * rate.prices[token.symbol];
            }
            log = {
                "time": new Date(),
                "value": balance
            }
            await users_collection.updateOne({"username": user.username, "schemes.id": scheme.id}, 
                                            {'$push': {["schemes.$.propertyLogs"]: log}});
        }
    }
    await mongodb_client.close();
}


async function getSchemeAddrs() {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    const projection = {'username': 1, 'schemes': {'id': 1, 'chainAddresses': 1, 'chargeLogs': 1, 'withdrawLogs': 1}};
    const users = await users_collection.find().project(projection).toArray();
    var result = [];
    for (const user of users) {
        for (const scheme of user.schemes) {
            const bscObj = scheme.chainAddresses.filter(obj => (obj['name'].indexOf('BSC') != -1))[0];
            const bscAddr = bscObj.address;
            result.push({'username': user.username, 'schemeId': scheme.id, 'bscAddr': bscAddr});
        }
    }
    await mongodb_client.close();
    return result;
}


async function setInvestStatus(username, schemeId, status) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    await users_collection.updateOne({"username": username, "schemes.id": schemeId}, {'$set': {"schemes.$.investStatus": status}});
    await mongodb_client.close();
    return true;
}


async function getPlan(username, schemeId) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    const user = await users_collection.findOne({"username": username, "schemes.id": schemeId}, {projection: {'schemes.$': 1}});
    const plans = user.schemes[0].investPlans
    const plan = plans[plans.length-1].contents
    var planObj = {}
    for (const token of plan) {
        planObj[token.coin] = token.percentage * 0.01
    }
    await mongodb_client.close();
    return planObj;
}


// chargeOrWithdraw: "chargeLogs", "withdrawLogs"
async function updateChargeOrWithdrawLog(username, schemeId, logs, log) {
    await mongodb_client.connect();
    const users_collection = mongodb_client.db(mongodb_db).collection(mongodb_collection);
    await users_collection.updateOne({"username": username, "schemes.id": schemeId}, {'$push': {["schemes.$."+logs]: log}});
    await mongodb_client.close();
    return true;
}


const mydb = {
    'getSchemeAccount': getSchemeAccount,
    'setSchemeAccount': setSchemeAccount,
    'getSchemeAddrs': getSchemeAddrs,
    'updateChargeOrWithdrawLog': updateChargeOrWithdrawLog,
    'updatePropertyLog': updatePropertyLog,
    'setProperties': setProperties,
    'setInvestStatus': setInvestStatus,
    'getPlan': getPlan,
    'CHARGE': 'chargeLogs',
    'WITHDRAW': 'withdrawLogs',
    'Double': Double,
}
module.exports = mydb;


async function main() {
    // var result = await getExchangeRate();
    // console.log(result);

    // await updateProperties();
    // await getUserAddrs();
    // await updateChargeOrWithdrawLog();
    // await getUserAddr("liyuan@comp.nus.edu.sg", 1, "BEP20 (BSC)");
    // await getPlan('liyuan@comp.nus.edu.sg', 1);
}


// main();
