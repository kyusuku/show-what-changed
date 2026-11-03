import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
const modulePath = process.argv.find((arg) => arg.startsWith('--module='))?.slice('--module='.length) ?? '../dist/schema/index.js';
const { DOCUMENT_SCHEMAS } = await import(new URL(modulePath, import.meta.url).href);

const check = process.argv.includes('--check');
if (!check) await mkdir(new URL('../schema/', import.meta.url), { recursive: true });
for (const [name, schema] of Object.entries(DOCUMENT_SCHEMAS)) {
  const json = z.toJSONSchema(schema, { io: name === 'config' || name === 'scenario' ? 'input' : 'output' });
  const text = JSON.stringify(json, null, 2) + '\n';
  const path = new URL(`../schema/${name}.v2.json`, import.meta.url);
  if (check) {
    if (await readFile(path, 'utf8') !== text) throw new Error(`${name}.v2.json is stale`);
  } else await writeFile(path, text);
}
