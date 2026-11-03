const http = require('node:http');
http.createServer((req, res) => res.end(JSON.stringify({ side: process.env.SWC_SIDE, cwd: process.cwd(), origin: process.env.APP_ORIGIN, secret: process.env.PRIVATE_VALUE, service: process.env.SERVICE_URL }))).listen(Number(process.argv[2]), '127.0.0.1');
