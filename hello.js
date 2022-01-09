const axios = require('axios')
const WebSocket = require('ws');


axios.post('http://localhost:3000/getAddress', {
    "username": "liyuan@comp.nus.edu.sg", 
    "id": 1, 
    "chain": "BEP20 (BSC)"
}).then(res => {
    console.log(res.data);
})


axios.post('http://localhost:3000/withdraw', {
    "username": "liyuan@comp.nus.edu.sg", 
    "id": 1, 
    'coin': 'USDT',
    'chain': 'BEP20 (BSC)',
    'address': '0xC879335743bAE5454b65e18C834b63E800938cc0',
    "quantity": 1
}).then(res => {
    console.log(res.data);
})


axios.get('http://localhost:3000/updateInvestPlan?username=liyuan@comp.nus.edu.sg&id=1').then(res => {
    console.log(res.data);
})


// const conn = new WebSocket("wss://testnet-dex.binance.org/api/ws/0x11b19603221518F93Bb236226Fc04213692Ec82e");
// conn.onopen = function(evt) {
//     // send Subscribe/Unsubscribe messages here (see below)
//     console.log(evt);
// }
// conn.onmessage = function(evt) {
//     console.info('received data', evt.data);
// };
// conn.onerror = function(evt) {
//     console.error('an error occurred', evt.data);
// };
