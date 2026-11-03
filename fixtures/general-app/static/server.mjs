import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./index.html', import.meta.url));
http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html); }).listen(Number(process.argv[2]), '127.0.0.1');
