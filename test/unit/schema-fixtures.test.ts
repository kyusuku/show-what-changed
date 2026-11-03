import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { CaptureBundleSchema, ScenarioSchema, parseScenario } from '../../src/schema/index.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validate = ajv.compile(z.toJSONSchema(ScenarioSchema, { io: 'input' }));
const directory = new URL('../fixtures/scenarios/', import.meta.url);
const names = await readdir(directory);

describe('T01 committed contract fixtures', () => {
  it.each(names.filter((name) => name.endsWith('.json')))('accepts %s through runtime and generated schemas', async (name) => {
    const value: unknown = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    expect(parseScenario(value).steps[0]?.op).toBe('goto');
    expect(validate(value)).toBe(true);
  });
  it('accepts the persisted synthetic capture bundle', async () => {
    const value: unknown = JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8'));
    expect(CaptureBundleSchema.parse(value).scenarios).toHaveLength(1);
  });
});
