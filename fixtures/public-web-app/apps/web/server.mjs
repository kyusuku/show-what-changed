import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { columns, feedback, library, tasks, validateProposal } from '@workshop/board-data';

const portText = process.argv[2] ?? process.env.PORT ?? '4173';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('A port from 1 to 65535 is required.');
const publicFiles = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/api/board') {
      json(response, 200, { columns, library, tasks });
      return;
    }
    if (request.method === 'POST' && path === '/api/proposals') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) {
          json(response, 413, { error: 'This task is too large.' });
          return;
        }
      }
      let input;
      try { input = JSON.parse(body); }
      catch { json(response, 400, { error: 'Send task details as JSON.' }); return; }
      const result = validateProposal(input);
      if (result.errors.length > 0) {
        json(response, 422, { feedback, errors: result.errors });
        return;
      }
      json(response, 201, { task: { id: `proposal-${result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: result.title, description: 'A new idea from the workshop.', category: 'New idea', status: 'ready', owner: 'You' } });
      return;
    }
    if (request.method !== 'GET') { json(response, 405, { error: 'This method is not available.' }); return; }
    const file = publicFiles.get(path);
    if (file) {
      response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
      response.end(await readFile(new URL(`./public/${file[0]}`, import.meta.url)));
      return;
    }
    if (['/', '/board', '/proposals'].includes(path)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(new URL('./public/index.html', import.meta.url)));
      return;
    }
    json(response, 404, { error: 'This page does not exist.' });
  } catch {
    if (!response.headersSent) json(response, 500, { error: 'The workshop could not load this request.' });
    else response.end();
  }
});
server.listen(Number(portText), '127.0.0.1', () => process.stdout.write(`Workshop board is ready at http://127.0.0.1:${portText}/board\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
