require('node:http').createServer((req, res) => res.end(process.env.PREVIOUS)).listen(Number(process.argv[2]), '127.0.0.1');
