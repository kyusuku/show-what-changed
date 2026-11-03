import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const origin = new URL(process.env.APP_ORIGIN);
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.port, process.env.PORT);
assert.equal(process.env.DB_HOST, '127.0.0.1');
assert.notEqual(process.env.DB_PORT, '5432');
await writeFile(join(process.env.DATA, 'setup.json'), JSON.stringify({ origin: origin.origin, port: process.env.PORT, dbHost: process.env.DB_HOST, dbPort: process.env.DB_PORT }), { mode: 0o600 });
