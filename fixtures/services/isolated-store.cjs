const fs = require('node:fs');
const http = require('node:http');
const file = process.env.DATA + '/data';
fs.writeFileSync(file, fs.readFileSync(process.env.SEED));
http.createServer((req, res) => {
  if (req.method === 'POST') { fs.writeFileSync(file, 'changed'); res.end('ok'); }
  else res.end(JSON.stringify({ data: fs.readFileSync(file, 'utf8'), leaked: process.env.PRIVATE_VALUE, previous: process.env.PREVIOUS }));
}).listen(Number(process.argv[2]), '127.0.0.1');
