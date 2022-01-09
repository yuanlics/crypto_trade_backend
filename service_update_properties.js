const myweb3 = require('./backend_web3')

async function main() {
    var cnt = 0
    while (true) {
        await myweb3.updateProperties();
        cnt += 1;
        console.log(cnt);
        if (cnt % 5 == 0) {
            await myweb3.updatePropertyLog();
        }
        await new Promise(r => setTimeout(r, 60e3));
    }
}

main()
