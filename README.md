# crypto_trade_backend

## Run backend

Step 1: In config/provider.conf, delete the row containing "lastBlockHash".

Step 2: 
```
NODE_ENV=production nohup node backend_http.js > backend_http.log & disown
NODE_ENV=production nohup node service_update_properties.js > service_update_properties.log & disown
NODE_ENV=production nohup node service_update_logs.js > service_update_logs.log & disown
```

## Kill backend
```
pkill -f "node backend_http.js"
pkill -f "node service_update_properties.js"
pkill -f "node service_update_logs.js"
```
