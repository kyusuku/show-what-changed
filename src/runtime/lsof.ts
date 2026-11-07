import { gte, valid } from 'semver';

export const LSOF_SETUP = 'Install lsof on PATH. Linux requires version 4.99.7 or newer. See https://github.com/kyusuku/show-what-changed/blob/main/docs/installation.md#linux-setup, then rerun show-what-changed setup.';

export function lsofCapability(output: string, platform: NodeJS.Platform = process.platform): { supported: boolean; version: string | null } {
  const revision = /^\s*revision:\s*(\d+\.\d+(?:\.\d+)?)(?:\s|$)/m.exec(output)?.[1];
  const version = revision ? valid(revision.split('.').length === 2 ? `${revision}.0` : revision) : null;
  return { supported: platform !== 'linux' || (version !== null && gte(version, '4.99.7')), version: revision ?? null };
}
