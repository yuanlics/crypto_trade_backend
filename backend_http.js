const express = require('express')
const myweb3 = require('./backend_web3')

const app = express()
const port = 3456

app.use(
    express.urlencoded({
        extended: true
    })
)

app.use(express.json())

app.post('/getAddress', async (req, res) => {
    const addr = await myweb3.getOrCreateAddress(req.body.username, req.body.id, req.body.chain);
    res.send(addr);
})

app.post('/withdraw', async (req, res) => {
    const result = await myweb3.withdraw(req.body.username, req.body.id, req.body.coin, req.body.chain, req.body.address, req.body.quantity);
    res.send(result);
})

app.get('/updateInvestPlan', async (req, res) => {
    const result = await myweb3.rebalance(req.query.username, Number(req.query.id));
    res.send(result);
})

app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`)
})
