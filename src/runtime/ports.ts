import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunContext } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';
import { atomicPrivateFile, hasCode, readContainedFile, readRunFile, safeDirectory } from './files.js';
import { processTable } from './process-table.js';
const PortSchema = z.strictObject({ port: z.number().int().min(4310).max(4499), nonce: z.string().regex(/^[a-f0-9]{32}$/), device: z.number(), inode: z.number() });
const OwnerSchema = z.strictObject({ runId: z.string(), nonce: z.string(), pid: z.number().int().positive(), started: z.string() });
const LedgerSchema = z.strictObject({ runId: z.string(), reservations: z.array(PortSchema).max(30) });
type Reservation = z.infer<typeof PortSchema>;
const held = new WeakMap<RunContext, Reservation[]>();
async function reservationRoot(): Promise<string> { const root = join(await realpath(tmpdir()), 'show-what-changed-ports'); await safeDirectory(root, true); return root; }
async function release(root: string, reservation: Reservation, runId: string): Promise<void> {
  const directory = join(root, String(reservation.port));
  let stat;
  try { stat = await lstat(directory); } catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  const owner = OwnerSchema.parse(JSON.parse((await readContainedFile(directory, 'owner.json', 4096)).toString('utf8')));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== reservation.device || stat.ino !== reservation.inode || owner.runId !== runId || owner.nonce !== reservation.nonce) throw failure(5, 'PORT_OWNERSHIP_UNCERTAIN', 'cleanup', 'A port reservation changed ownership.', 'Inspect the exact reservation before retrying.');
  await rm(directory, { recursive: true });
}
export async function reservePort(port: number, run: RunContext): Promise<boolean> {
  const root = await reservationRoot(); const directory = join(root, String(port));
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    try {
      const stat = await lstat(directory);
      const owner = OwnerSchema.parse(JSON.parse((await readContainedFile(directory, 'owner.json', 4096)).toString('utf8')));
      if ((await processTable()).some((row) => row.pid === owner.pid && row.started === owner.started)) return false;
      await release(root, { port, nonce: owner.nonce, device: stat.dev, inode: stat.ino }, owner.runId);
      return reservePort(port, run);
    } catch { return false; }
  }
  const nonce = randomBytes(16).toString('hex'); const stat = await lstat(directory);
  const reservation = { port, nonce, device: stat.dev, inode: stat.ino };
  let registered = false;
  try {
    const identity = (await processTable()).find((row) => row.pid === process.pid);
    if (!identity) throw new Error('Missing owner identity');
    await atomicPrivateFile(directory, 'owner.json', JSON.stringify({ runId: run.runId, nonce, pid: identity.pid, started: identity.started }), false);
    run.resources.register({ kind: 'lock', identity: `port-${port}-${nonce}`, dispose: async () => release(root, reservation, run.runId) }); registered = true;
    const reservations = held.get(run) ?? []; reservations.push(reservation); held.set(run, reservations);
    await atomicPrivateFile(run.paths.privateDir, 'ports.json', JSON.stringify({ runId: run.runId, reservations }), true);
    return true;
  } catch (error) { if (!registered) await release(root, reservation, run.runId).catch(() => {}); throw error; }
}
export async function releasePortReservations(runDir: string, runId: string): Promise<void> {
  let ledger: z.infer<typeof LedgerSchema>;
  try { ledger = LedgerSchema.parse(JSON.parse((await readRunFile(runDir, 'private/ports.json', 65536)).toString('utf8'))); }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  if (ledger.runId !== runId) throw new Error('Port reservation ledger changed ownership');
  const root = await reservationRoot();
  for (const reservation of ledger.reservations) await release(root, reservation, runId);
}
