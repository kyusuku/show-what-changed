import { gte, valid } from 'semver';

export const LSOF_SETUP = 'Install lsof on PATH. Linux requires version 4.99.7 or newer. See the README Linux setup instructions, then rerun doctor.';

export function lsofCapability(output: string, platform: NodeJS.Platform = process.platform): { supported: boolean; version: string | null } {
  const revision = /^\s*revision:\s*(\d+\.\d+(?:\.\d+)?)(?:\s|$)/m.exec(output)?.[1];
  const version = revision ? valid(revision.split('.').length === 2 ? `${revision}.0` : revision) : null;
  return { supported: platform !== 'linux' || (version !== null && gte(version, '4.99.7')), version: revision ?? null };
}
