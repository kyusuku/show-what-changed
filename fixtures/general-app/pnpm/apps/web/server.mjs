import http from 'node:http';
import { title } from 'swc-general-shared';
http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<h1>${title}</h1><button onclick="this.textContent='Selected'">Select item</button>`); }).listen(Number(process.argv[2]), '127.0.0.1');
