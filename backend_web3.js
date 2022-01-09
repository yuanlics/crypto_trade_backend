const Web3 = require('web3');
const path = require('path');
const fs = require('fs');
const abiDecoder = require('abi-decoder');

const mydb = require('./backend_db');
const { resourceLimits } = require('worker_threads');

const configDir = "./config";
const providerPath = path.join(configDir, 'provider.conf');
const tokenAddrPath = path.join(configDir, 'tokenAddr.conf');

const bep20ABIPath = path.join(configDir, 'bep20.abi');
const wbnbABIPath = path.join(configDir, 'wbnb.abi');
const pancakeRouterABIPath = path.join(configDir, 'pancakeRouter.abi');

const providerConfig = JSON.parse(fs.readFileSync(providerPath));
const tokenAddrConfig = JSON.parse(fs.readFileSync(tokenAddrPath));

const netName = "bsc_testnet";
const chainProvider = providerConfig[netName]['provider'];
const chainProvider2 = providerConfig[netName]['provider2'];
const chainProvider3 = providerConfig[netName]['provider3'];
const chainProvider4 = providerConfig[netName]['provider4'];
const chainProvider5 = providerConfig[netName]['provider5'];
const chainProvider6 = providerConfig[netName]['provider6'];
const chainID = Number(providerConfig[netName]['chainID']);
const pancakeRouter = providerConfig[netName]['pancakeRouter'];

const web3 = new Web3(chainProvider);
const web3_2 = new Web3(chainProvider2);


const abi_bep20 = JSON.parse(fs.readFileSync(path.resolve(__dirname, bep20ABIPath), 'utf-8'));
const abi_wbnb = JSON.parse(fs.readFileSync(path.resolve(__dirname, wbnbABIPath), 'utf-8'));
const abi_pancakeRouter = JSON.parse(fs.readFileSync(path.resolve(__dirname, pancakeRouterABIPath), 'utf-8'));

abiDecoder.addABI(abi_bep20)
abiDecoder.addABI(abi_pancakeRouter)

const tokenAddresses = tokenAddrConfig[netName]


function createAccount() {
    return web3.eth.accounts.create();  // sync
}


function getAccount(privateKey) {
    return web3.eth.accounts.privateKeyToAccount(privateKey);  // not async
}


// ************ HTTP METHODS ************* //

async function getOrCreateAddress(username, schemeId, chainName) {
    const account = await mydb.getSchemeAccount(username, schemeId, chainName);
    var addr = account.address;
    if (addr != null) {
        return addr;
    } else {
        account = createAccount();
        await mydb.setSchemeAccount(username, schemeId, chainName, account);
        return account.address;
    }
}


async function withdraw(username, schemeId, coinName, chainName, toAddr, quantity) {
    const account = await mydb.getSchemeAccount(username, schemeId, chainName);
    if (coinName == 'USDT' && chainName == 'BEP20 (BSC)') {
        const tokenName = 'bep20_usdt';
        const amount = quantity * 1e18;
        var result = await sendToken(account, {'address': toAddr}, tokenName, amount);
        return result;
    } else {
        return false;
    }
}


async function rebalance(username, schemeId) {
    const chainName = 'BEP20 (BSC)';
    const keep = 0.99  // keep a small ratio for any transaction
    const discount = 0.8;  // allow some discount for amountOutMin

    const account = await mydb.getSchemeAccount(username, schemeId, chainName);
    var result = await mydb.setInvestStatus(username, schemeId, 'pending');
    var tokens = await getTokenBalances(account);
    console.log(tokens);

    var plan = await mydb.getPlan(username, schemeId);  // { USDT: 0.2, ETH: 0.2, BTC: 0.3, BNB: 0.3 }
    var plan_new = {}
    for (const tokenName of Object.keys(plan)) {
        const name = 'bep20_' + tokenName.toLowerCase()
        plan_new[name] = plan[tokenName]
    }
    plan = plan_new

    for (const tokenName of Object.keys(tokens)) {
        var amount = Math.trunc(Number(tokens[tokenName] * keep * 1e18))  // wei
        if (amount > 0) {
            var srcAddress = tokenAddresses[tokenName];
            var bnbAddress = tokenAddresses['bep20_wbnb'];
            amount = web3.utils.toHex(amount);
            var swap_path = [srcAddress, bnbAddress];
            var rate_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter);
            var amountsOut = await rate_contract.methods.getAmountsOut(amount, swap_path).call();
            var amountOutMin = web3.utils.toHex(Math.trunc(Number(discount * amountsOut[1])));
            var result = await swapBNBfromToken(account, tokenName, amount, amountOutMin);
        }
    }

    bnbAmount = await getMainBalance(account);  // wei
    for (const tokenName of Object.keys(plan)) {
        if (tokenName == 'bep20_bnb') {
            continue;
        }
        amount = Math.trunc(Number(bnbAmount * plan[tokenName] * keep));
        if (amount > 0) {
            var bnbAddress = tokenAddresses['bep20_wbnb'];
            var dstAddress = tokenAddresses[tokenName];
            amount = web3.utils.toHex(amount);
            var swap_path = [bnbAddress, dstAddress];
            var rate_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter);
            var amountsOut = await rate_contract.methods.getAmountsOut(amount, swap_path).call();
            var amountOutMin = web3.utils.toHex(Math.trunc(Number(discount * amountsOut[1])));
            var result = await swapBNBtoToken(account, tokenName, amount, amountOutMin);
        }
    }

    var tokens = await getTokenBalances(account);
    console.log(tokens);
    var result = await mydb.setInvestStatus(username, schemeId, 'normal');
}


// ************ HTTP METHODS ************* //




async function getMainBalance(account) {
    return await web3.eth.getBalance(account.address);
}


async function getTokenBalance(account, tokenName) {
    const contract = new web3.eth.Contract(abi_bep20, tokenAddresses[tokenName]);
    const tokenBalance = await contract.methods.balanceOf(account.address).call();
    return tokenBalance;
}


async function getTokenBalances(account) {
    var tokBal = Object();
    for (const symbol of Object.keys(tokenAddresses)) {
        if (symbol == 'bep20_wbnb') {
            continue;
        }
        const tokenBalance = await getTokenBalance(account, symbol);
        await new Promise(r => setTimeout(r, 50));  // rate limit
        tokBal[symbol] = tokenBalance / 1e18;
    }
    return tokBal;
}


async function runTransaction(account, tx) {
    const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey)
                                            .catch((err) => {
                                                console.log('promise failed', err);
                                                return false;
                                            });
    if (!signedTx) {
        return false;
    }

    // TODO: can use "then" and "catch" only, without using "on" events?
    // https://web3js.readthedocs.io/en/v1.3.4/web3-eth.html?highlight=sendSignedTransaction#eth-sendtransaction-return

    const sentTx = await web3.eth.sendSignedTransaction(signedTx.raw || signedTx.rawTransaction)
                                    // .on("receipt", receipt => {
                                    //     console.log('transaction "on" succeeded with receipt:', receipt);
                                    //     return true;
                                    // })
                                    // .on("error", err => {
                                    //     console.log('transaction failed with error:', err);
                                    //     return false;
                                    // })
                                    .then((receipt) => {
                                        console.log('transaction succeeded with receipt:', receipt);
                                        return true;
                                    })
                                    .catch((err) => {
                                        console.log('transaction failed with error', err);
                                        return false;
                                    });
    return sentTx

    // const signPromise = web3.eth.accounts.signTransaction(tx, account.privateKey);
    // return signPromise.then((signedTx) => {
    //     const sentTx = web3.eth.sendSignedTransaction(signedTx.raw || signedTx.rawTransaction);
    //     sentTx.on("receipt", receipt => {
    //         console.log('transaction succeeded');
    //         return true;
    //     });
    //     sentTx.on("error", err => {
    //         console.log('transaction failed', err);
    //         return false;
    //     });
    // }).catch((err) => {
    //     console.log('promise failed', err);
    //     return false;
    // });
}


async function sendBNB(accountFrom, accountTo, amount) {  // in default, amount is in wei
    const tx = {
        from: accountFrom.address, 
        to: accountTo.address, 
        value: amount,
        gas: 21000,  // unused gas is refunded, so can also use 5000000 as in https://docs.binance.org/smart-chain/developer/BEP20.html
        // gasPrice: 18e9,  // can use default
    };
    return await runTransaction(accountFrom, tx);
}


async function sendToken(accountFrom, accountTo, tokenName, amount) {
    // var count = await web3.eth.getTransactionCount(accountFrom.address);
    var contract = new web3.eth.Contract(abi_bep20, tokenAddresses[tokenName], { from: accountFrom.address });
    var transferAmount = web3.utils.toHex(amount);
    var data = contract.methods.transfer(accountTo.address, transferAmount).encodeABI();
    
    var tx = {
        // "nonce": web3.utils.toHex(count),  // can use default
        // "gas": 5000,  // not needed
        // "gasPrice": web3.utils.toHex(gasPrice),  // can use default
        "from": accountFrom.address,
        "to": tokenAddresses[tokenName],
        "gasLimit": web3.utils.toHex(210000),  // TODO: why?
        "value":"0x0",  // 0 since not sending BNB
        "data": data,
        "chainId": chainID,
    };
    return await runTransaction(accountFrom, tx);
}


// async function convertWBNB(account, amount, doDeposit=true) {  // not needed if directly swap BNB
//     var contract = new web3.eth.Contract(abi_wbnb, tokenAddresses['bep20_wbnb'], { from: account.address });
//     var data, transferAmount;
//     if (doDeposit == true) {
//         data = contract.methods.deposit().encodeABI();
//         transferAmount = web3.utils.toHex(amount);
//     } else {
//         data = contract.methods.withdraw(web3.utils.toHex(amount)).encodeABI();
//         transferAmount = web3.utils.toHex(0);
//     }
    
//     var tx = {
//         "from": account.address,
//         "to": tokenAddresses['bep20_wbnb'],
//         "gasLimit": web3.utils.toHex(210000),
//         "value": transferAmount,
//         "data": data,
//         "chainId": chainID,
//     };
//     return await runTransaction(account, tx);
// }


// async function depositWBNB(account, amount) {  // not needed if directly swap BNB
//     return await convertWBNB(account, amount, doDeposit=true);
// }


// async function withdrawWBNB(account, amount) {  // not needed if directly swap BNB
//     return await convertWBNB(account, amount, doDeposit=false);
// }


// refer from: https://stackoverflow.com/questions/64526925/how-to-swap-tokens-on-uniswap-using-web3-js
async function swapBNBtoToken(account, dstTokenName, bnbAmount, amountOutMin) {
    var srcAddress = tokenAddresses['bep20_wbnb'];
    var dstAddress = tokenAddresses[dstTokenName];

    // var amountOutMin = '0';  // TODO: use exchange rate?
    
    var contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter, {from: account.address});

    var data = contract.methods.swapExactETHForTokens(  // TODO: swapExactETHForTokensSupportingFeeOnTransferTokens ?
        web3.utils.toHex(amountOutMin),
        [srcAddress, dstAddress],
        account.address,
        web3.utils.toHex(Math.round(Date.now()/1000)+60*20),  // TODO: deadline?
    );

    var tx = {
        "from": account.address,
        "gasLimit": web3.utils.toHex(290000),
        "to": pancakeRouter,
        "value": web3.utils.toHex(bnbAmount),
        "data": data.encodeABI(),
    };
    return await runTransaction(account, tx);
}


async function swapBNBfromToken(account, srcTokenName, srcTokenAmount, amountOutMin) {
    var srcAddress = tokenAddresses[srcTokenName];
    var dstAddress = tokenAddresses['bep20_wbnb'];
    srcTokenAmount = web3.utils.toHex(srcTokenAmount);

    var approve_contract = new web3.eth.Contract(abi_bep20, srcAddress, {from: account.address});
    var approve_data = approve_contract.methods.approve(pancakeRouter, srcTokenAmount).encodeABI();
    var tx = {
        "from": account.address,
        "to": srcAddress,
        "gasLimit": web3.utils.toHex(210000),
        "value": "0x0",
        "data": approve_data,
    };
    var result = await runTransaction(account, tx);
    console.log(result);
    if (!result) {return false;}
    
    // var amountOutMin = web3.utils.toHex(0);  // TODO: use exchange rate?
    var swap_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter, {from: account.address});
    var swap_data = swap_contract.methods.swapExactTokensForETHSupportingFeeOnTransferTokens(  // TODO: swapExactETHForTokens ?
        srcTokenAmount,
        amountOutMin,
        [srcAddress,
        //  '0xe9e7cea3dedca5984780bafc599bd69add087d56' /* BUSD address */, // Add this if you want to go through the onlyone-busd pair
        dstAddress],
        account.address,
        web3.utils.toHex(Math.round(Date.now()/1000)+60*20),  // TODO: deadline?
    ).encodeABI();

    var tx = {
        "from": account.address,
        "to": pancakeRouter,
        "gasLimit": web3.utils.toHex(460000),
        "value": web3.utils.toHex(0),
        "data": swap_data,
    };
    return await runTransaction(account, tx);
}


// srcToken->BNB->dstToken
async function swapTokenToToken(account, srcTokenName, dstTokenName, srcTokenAmount) {
    var srcAddress = tokenAddresses[srcTokenName];
    var bnbAddress = tokenAddresses['bep20_wbnb'];
    var dstAddress = tokenAddresses[dstTokenName];
    srcTokenAmount = web3.utils.toHex(srcTokenAmount);
    const discount = 0.9;  // tolerable discount during swapping

    var swap_path = [srcAddress, bnbAddress];
    var rate_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter);
    var amountsOut = await rate_contract.methods.getAmountsOut(srcTokenAmount, swap_path).call();
    var bnbAmount = web3.utils.toHex(Number(amountsOut[1]));  // use exchange rate
    var bnbAmountMin = web3.utils.toHex(Math.trunc(Number(discount * amountsOut[1])));
    console.log('rates:', amountsOut[0]/1e18, amountsOut[1]/1e18, discount*amountsOut[1]/1e18);

    var swap_path = [bnbAddress, dstAddress];
    var rate_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter);
    var amountsOut = await rate_contract.methods.getAmountsOut(bnbAmount, swap_path).call();
    var dstAmount = web3.utils.toHex(Number(amountsOut[1]));  // use exchange rate
    var dstAmountMin = web3.utils.toHex(Math.trunc(Number(discount * amountsOut[1])));
    console.log('rates:', amountsOut[0]/1e18, amountsOut[1]/1e18, discount*amountsOut[1]/1e18);

    var result = await swapBNBfromToken(account, srcTokenName, srcTokenAmount, bnbAmountMin);
    if (!result) {return false;}
    var result = await swapBNBtoToken(account, dstTokenName, bnbAmount, dstAmountMin);
    return result;
}


// // UNUSED.
// async function swapTokenToToken(account, srcTokenName, dstTokenName, srcTokenAmount) {
//     var srcAddress = tokenAddresses[srcTokenName];
//     var dstAddress = tokenAddresses[dstTokenName];
//     srcTokenAmount = web3.utils.toHex(srcTokenAmount);

//     var approve_contract = new web3.eth.Contract(abi_bep20, srcAddress, {from: account.address});
//     var approve_data = approve_contract.methods.approve(pancakeRouter, srcTokenAmount).encodeABI();  // TODO: approve amount?
//     var tx = {
//         "from": account.address,
//         "to": srcAddress,
//         "gasLimit": web3.utils.toHex(210000),
//         "value": "0x0",
//         "data": approve_data,
//     };
//     var result = await runTransaction(account, tx);
//     console.log(result);
//     if (!result) {
//         return false;
//     }

//     const swap_path = [srcAddress, dstAddress];
//     var rate_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter);
//     var amountsOut = await rate_contract.methods.getAmountsOut(srcTokenAmount, swap_path).call();
//     // var amountOutMin = web3.utils.toHex(0);
//     var amountOutMin = web3.utils.toHex(Number(amountsOut[1]));  // use exchange rate
    
//     var swap_contract = new web3.eth.Contract(abi_pancakeRouter, pancakeRouter, {from: account.address});
//     var swap_data = swap_contract.methods.swapExactTokensForTokensSupportingFeeOnTransferTokens(  // TODO: swapExactETHForTokens ?
//     // var swap_data = swap_contract.methods.swapExactTokensForTokens(
//         srcTokenAmount,
//         amountOutMin,
//         swap_path,
//         account.address,
//         web3.utils.toHex(Math.round(Date.now()/1000)+60*20),  // TODO: deadline?
//     ).encodeABI();

//     var tx = {
//         "from": account.address,
//         "to": pancakeRouter,
//         "gasLimit": web3.utils.toHex(460000),
//         "value": web3.utils.toHex(0),
//         "data": swap_data,
//     };
//     return await runTransaction(account, tx);
// }


// Go through the new blocks once to update the charge and withdraw logs.
async function updateChargeWithdrawLogs() {
    // beginBlockHash: the beginning block when platform goes online. no need to change
    // lastBlockHash: the block processed last time. can be reset to beginBlcokHash
    const lastBlockHash = providerConfig[netName]['lastBlockHash'] || providerConfig[netName]['beginBlockHash'];
    // const lastBlockHash = '0xcdfea4c4b0333f877ff4d4c0cdbc7b05f4c87631c1481a6335a21287dcc6e238';  // DEBUG
    
    const users = await mydb.getSchemeAddrs();
    const addr2idx = {};
    for (var i = 0; i < users.length; i++) {
        addr2idx[users[i].bscAddr.toLowerCase()] = i;
    }
    const userAddrs = new Set(Object.keys(addr2idx));

    var block = await web3.eth.getBlock('latest', true);
    // var block = await web3.eth.getBlock('0xfaab54a0d0a0b520284492eb4ff9ff544ab852a84b80d5c6f9133a8aeb872297', true);  // DEBUG
    const latestBlockHash = block.hash;


    var chargeObjs = [], withdrawObjs = []
    while (true) {
        if (block.number % 1 == 0) {
            console.log(block.number);
        }
        for (const tx of block.transactions) {

            // process USDT charge and withdraw
            if (tx.to && tx.input && tx.to.toLowerCase() == tokenAddresses['bep20_usdt'].toLowerCase()) {
                const data = abiDecoder.decodeMethod(tx.input);
                
                if (data && data.name 
                && (data.name == 'transfer')
                && (data.params[0].name == 'recipient')
                && (userAddrs.has(data.params[0].value.toLowerCase()))) {  // charge log
                    var amount = mydb.Double(data.params[1].value / 1e18)
                    log = {
                        "coin": "USDT",
                        "amount": amount,
                        "time": new Date(block.timestamp * 1000),
                        "address": tx.from.toLowerCase(),
                        "transferID": tx.hash,
                        "status": "Completed"
                    }
                    const userAddr = data.params[0].value.toLowerCase();
                    const username = users[addr2idx[userAddr]].username
                    const schemeId = users[addr2idx[userAddr]].schemeId
                    chargeObjs.push({username, schemeId, log})
                    console.log('found charge:', username, schemeId, log);
                }

                if (data && data.name 
                && (data.name == 'transfer')
                && (data.params[0].name == 'recipient')
                && (userAddrs.has(tx.from.toLowerCase()))) {  // withdraw log
                    var amount = mydb.Double(data.params[1].value / 1e18)
                    log = {
                        "coin": "USDT",
                        "amount": amount,
                        "time": new Date(block.timestamp * 1000),
                        "address": data.params[0].value.toLowerCase(),
                        "transferID": tx.hash,
                        "status": "Completed"
                    }
                    const userAddr = tx.from.toLowerCase();
                    const username = users[addr2idx[userAddr]].username
                    const schemeId = users[addr2idx[userAddr]].schemeId
                    withdrawObjs.push({username, schemeId, log})
                    console.log('found withdraw:', username, schemeId, log);
                }
            }

        }
        if (block.parentHash == lastBlockHash) {
            break
        }
        await new Promise(r => setTimeout(r, 50));  // rate limit
        block = await web3.eth.getBlock(block.parentHash, true);
    }

    // insert logs in time order
    for (var i = chargeObjs.length - 1; i >= 0; i--) {
        const obj = chargeObjs[i]
        await mydb.updateChargeOrWithdrawLog(obj.username, obj.schemeId, mydb.CHARGE, obj.log);
    }
    for (var i = withdrawObjs.length - 1; i >= 0; i--) {
        const obj = withdrawObjs[i]
        await mydb.updateChargeOrWithdrawLog(obj.username, obj.schemeId, mydb.WITHDRAW, obj.log);
    }

    providerConfig[netName]['lastBlockHash'] = latestBlockHash;
    fs.writeFileSync(providerPath, JSON.stringify(providerConfig, null, 4));
}


// Update the properties once.
async function updateProperties() {
    const schemes = await mydb.getSchemeAddrs();
    for (var i = 0; i < schemes.length; i++) {
        addr = schemes[i].bscAddr.toLowerCase();
        account = {'address': addr};
        const bnb = await getMainBalance(account);
        const tokens = await getTokenBalances(account);
        const balances = Object.assign({'bnb': bnb/1e18}, tokens);
        await mydb.setProperties(schemes[i].username, schemes[i].schemeId, balances);
    }
}


async function main() {
    // const account = createAccount();
    // console.log(account);
    // return;

    const web3 = new Web3('https://data-seed-prebsc-1-s1.binance.org:8545');
    var result = await web3.eth.accounts.privateKeyToAccount('0x81a28d9a31d990f6f06a1dc15d78382c4f683a9ba681194b36d6937d4e10b3c2');
    console.log(result);
    var result = await web3.eth.getBlockNumber();
    console.log(result);

    // const privateKeyA = '0x81a28d9a31d990f6f06a1dc15d78382c4f683a9ba681194b36d6937d4e10b3c2';
    // const privateKeyB = '0xac8718e22955dcd01ec5bc4f28bbbe4e2fa6385eca9fbcf8bbb087ff70576461';
    // const privateKeyE = '0x2b5b9035c1cbf6d637e240ebc2823d50fa2604bc25e9fd8e22e37c558db6a962';

    // const accountA = getAccount(privateKeyA);
    // const accountB = getAccount(privateKeyB);
    // const accountE = getAccount(privateKeyE);

    // await getOrCreateAddress("liyuan@comp.nus.edu.sg", 1, "BEP20 (BSC)");
    // await getOrCreateAddress("new@comp.nus.edu.sg", 1, "BEP20 (BSC)");

    // console.log('account A address:', accountA.address);
    // console.log('account B address:', accountB.address);

    // var balanceA = await getMainBalance(accountA);
    // var balanceE = await getMainBalance(accountE);

    // console.log("account A balance:", balanceA/1e18);
    // console.log("account E balance:", balanceE/1e18);

    // var gasPrice = await web3.eth.getGasPrice();
    // console.log('gas price:', gasPrice);

    // const tokenBalancesA = await getTokenBalances(accountA);
    // const tokenBalancesE = await getTokenBalances(accountE);
    // console.log(tokenBalancesA);
    // console.log(tokenBalancesE);

    // await updateChargeWithdrawLogs();
    // await updateProperties();

    // await mydb.updatePropertyLog();

    // var result = await sendBNB(accountB, accountA, 0.1e18);
    // var result = await sendToken(accountB, accountA, "bep20_usdt", 1e18);
    // var result = await sendToken(accountE, accountA, "bep20_usdt", 2e18);

    // var result = await depositWBNB(accountA, 0.1e18);
    // var result = await withdrawWBNB(accountA, 0.1e18);
    
    // var result = await swapBNBtoToken(accountA, 'bep20_usdt', 0.01e18);
    // var result = await swapBNBfromToken(accountD, 'bep20_usdt', 5e18);
    // var result = await swapTokenToToken(accountA, 'bep20_usdt', 'bep20_dai', 1e18);
    // var result = await swapTokenToToken(accountA, 'bep20_dai', 'bep20_usdt', 1e18);
    // var result = await swapTokenToToken(accountE, 'bep20_btc', 'bep20_usdt', 0.000777165731928728e18);
    // console.log(result);

    // await rebalance('liyuan@comp.nus.edu.sg', 1);
}

const myweb3 = {
    'getOrCreateAddress': getOrCreateAddress,
    'withdraw': withdraw,
    'updateProperties': updateProperties,
    'updatePropertyLog': mydb.updatePropertyLog,
    'updateChargeWithdrawLogs': updateChargeWithdrawLogs,
    'rebalance': rebalance,
}
module.exports = myweb3;


main()
