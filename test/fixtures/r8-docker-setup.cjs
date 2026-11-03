const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const seed = readFileSync(process.env.SEED);
assert.deepEqual(JSON.parse(seed), { value: 7 });
assert(['before', 'after'].includes(process.env.SIDE));
const generated = {
  side: process.env.SIDE,
  seedSha256: createHash('sha256').update(seed).digest('hex'),
};
mkdirSync('generated', { recursive: true });
writeFileSync('generated/runtime.json', JSON.stringify(generated));
writeFileSync(join(process.env.DATA, 'setup.json'), JSON.stringify({
  port: process.env.PORT,
  origin: process.env.APP_ORIGIN,
  dbHost: process.env.DB_HOST,
  dbPort: process.env.DB_PORT,
  generated,
}));
