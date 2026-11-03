const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { join, resolve } = require('node:path');

async function main() {
  const command = process.argv[2];
  const port = process.argv[3];
  const side = process.env.SIDE;
  assert(['before', 'after'].includes(side));
  if (command === 'setup' || command === 'start') {
    assert.equal(process.env.PRIVATE_VALUE, undefined);
    assert.equal(process.env.SERVICE_VALUE, 'later-only');
    const expectedDependency = { side, endpoint: process.env.PREVIOUS, cwd: resolve(process.cwd(), '../store'), serviceValue: 'store-only', readiness: [503, 204], data: 'equal-seed' };
    const setup = { side, port, cwd: process.cwd(), serviceValue: process.env.SERVICE_VALUE, dependencyUrl: process.env.PREVIOUS, dependency: expectedDependency };
    const file = join(process.env.DATA, 'later-setup.json');
    if (command === 'setup') {
      const response = await fetch(process.env.PREVIOUS + '/observation', { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      const dependency = await response.json();
      assert.deepEqual(dependency, expectedDependency);
      fs.writeFileSync(file, JSON.stringify({ ...setup, dependency }));
      return;
    }
    const requiredSetup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(requiredSetup, setup);
    let readiness = 'unprobed';
    const server = http.createServer((req, res) => {
      if (req.url === '/ready') {
        if (readiness === 'unprobed') { readiness = 'rejected'; res.writeHead(503); }
        else { readiness = 'ready'; res.writeHead(204); }
        res.end(); return;
      }
      if (req.url === '/observation') {
        if (readiness !== 'ready') { res.writeHead(503); res.end(); return; }
        res.end(JSON.stringify({ side, endpoint: `http://127.0.0.1:${server.address().port}`, cwd: process.cwd(), serviceValue: process.env.SERVICE_VALUE, readiness: [503, 204], setup: requiredSetup })); return;
      }
      res.end(process.env.PREVIOUS);
    });
    server.listen(Number(port), '127.0.0.1');
    return;
  }
  if (command === 'app-setup') {
    const laterUrl = process.env.LATER_URL;
    const response = await fetch(laterUrl + '/observation', { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    const observed = await response.json();
    assert.equal(observed.side, side);
    assert.equal(observed.endpoint, laterUrl);
    assert.deepEqual(observed.readiness, [503, 204]);
    fs.writeFileSync(join(process.env.DATA, 'app-setup.json'), JSON.stringify({ side, laterUrl, observed }));
    return;
  }
  throw new Error('Unknown ordered service fixture command');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
