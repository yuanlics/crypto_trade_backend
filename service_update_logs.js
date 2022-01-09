const myweb3 = require('./backend_web3')

async function main() {
    while (true) {
        await myweb3.updateChargeWithdrawLogs();
        await new Promise(r => setTimeout(r, 60e3));
    }
}

main()
