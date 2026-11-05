import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { CaptureBundleSchema, ManifestSchema, ResultSchema, TOOL_VERSION } from '../../src/schema/index.js';

async function readObject(url: URL): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(url, 'utf8'));
  return z.record(z.string(), z.unknown()).parse(value);
}

const capture = await readObject(new URL('../fixtures/capture.json', import.meta.url));
const manifest = await readObject(new URL('../../docs/demo/motion-success/manifest.json', import.meta.url));
const result = { schemaVersion: 2, command: 'compose', status: 'ok', exitCode: 0, data: manifest, error: null, warnings: [] };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const documents = await Promise.all([
  { name: 'capture', runtime: CaptureBundleSchema, versioned: (toolVersion: string) => ({ ...capture, toolVersion }) },
  { name: 'manifest', runtime: ManifestSchema, versioned: (toolVersion: string) => ({ ...manifest, toolVersion }) },
  { name: 'result', runtime: ResultSchema, versioned: (toolVersion: string) => ({ ...result, data: { ...manifest, toolVersion } }) },
].map(async (document) => ({
  ...document,
  published: ajv.compile(await readObject(new URL(`../../schema/${document.name}.v2.json`, import.meta.url))),
})));

describe('schema2 patch producer compatibility', () => {
  it('preserves the historical producer identity in unchanged committed artifacts', () => {
    expect(CaptureBundleSchema.parse(capture).toolVersion).toBe('0.1.0');
    expect(ManifestSchema.parse(manifest).toolVersion).toBe('0.1.0');
    expect(TOOL_VERSION).toBe('0.1.1');
  });

  it.each(['0.1.0', '0.1.1'])('accepts known producer %s in runtime and published schemas', (version) => {
    for (const document of documents) {
      const value = document.versioned(version);
      expect(document.runtime.safeParse(value).success, document.name).toBe(true);
      expect(document.published(value), document.name).toBe(true);
    }
  });

  it.each(['0.0.9', '0.1.2', '0.2.0', '1.0.0', 'unknown'])('rejects unreviewed producer %s in runtime and published schemas', (version) => {
    for (const document of documents) {
      const value = document.versioned(version);
      expect(document.runtime.safeParse(value).success, document.name).toBe(false);
      expect(document.published(value), document.name).toBe(false);
    }
  });

  it('continues to reject version1 documents from a known producer', () => {
    for (const document of documents) {
      const value = { ...document.versioned('0.1.0'), schemaVersion: 1 };
      expect(document.runtime.safeParse(value).success, document.name).toBe(false);
      expect(document.published(value), document.name).toBe(false);
    }
  });
});
