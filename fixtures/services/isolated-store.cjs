const fs = require('node:fs');
const http = require('node:http');
const file = process.env.DATA + '/data';
fs.writeFileSync(file, fs.readFileSync(process.env.SEED));
let readiness = 'unprobed';
const server = http.createServer((req, res) => {
  if (req.url === '/ready') {
    if (readiness === 'unprobed') { readiness = 'rejected'; res.writeHead(503); }
    else { readiness = 'ready'; res.writeHead(204); }
    res.end(); return;
  }
  if (req.url === '/observation') {
    if (readiness !== 'ready') { res.writeHead(503); res.end(); return; }
    res.end(JSON.stringify({ side: process.env.SIDE, endpoint: `http://127.0.0.1:${server.address().port}`, cwd: process.cwd(), serviceValue: process.env.SERVICE_VALUE, readiness: [503, 204], data: fs.readFileSync(file, 'utf8') })); return;
  }
  if (req.method === 'POST') { fs.writeFileSync(file, 'changed'); res.end('ok'); }
  else res.end(JSON.stringify({ data: fs.readFileSync(file, 'utf8'), leaked: process.env.PRIVATE_VALUE, previous: process.env.PREVIOUS }));
});
server.listen(Number(process.argv[2]), '127.0.0.1');
