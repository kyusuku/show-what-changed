import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema, ScenarioSchema } from '../../src/schema/index.js';

it('ships schema 2 configuration and scenario files throughout public examples', async () => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git', '.show-what-changed', '.next', 'dist'].includes(entry.name)) await visit(path);
      else if (entry.isFile() && (entry.name === 'show-what-changed.config.json' || entry.name.endsWith('.scenario.json'))) files.push(path);
    }
  };
  await visit('fixtures');
  expect(files.length).toBeGreaterThanOrEqual(5);
  for (const path of files) {
    const schema = path.endsWith('.scenario.json') ? ScenarioSchema : ConfigSchema;
    expect(schema.safeParse(JSON.parse(await readFile(path, 'utf8'))), path).toMatchObject({ success: true });
  }
});
