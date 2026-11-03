import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContext } from '../schema/contracts.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { hasCode, safeDirectory } from './files.js';
import { CleanupLifetime, runCleanupLifetime } from './cleanup-lifetime.js';

function archiveError(): never { throw failure(6, 'INVALID_IMAGE_ARCHIVE', 'starting', 'The owned Docker image archive could not be verified.', 'Inspect private Docker diagnostics and retry with an intact export.'); }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }

export class DockerImageArchive {
  readonly relativePath: string;
  private readonly directory: string;
  private readonly created: Promise<Stats>;
  private active: Promise<unknown> | undefined;
  private state: 'open' | 'closing' | 'disposed' = 'open';
  private disposal: Promise<void> | undefined;
  private file: Stats | undefined;
  private processHeld = false;
  private readonly cleanup = new CleanupLifetime();
  private readonly runCleanup: CleanupLifetime;
  constructor(private readonly run: RunContext, name: string, private readonly removeBuilder: (deadline: number) => Promise<unknown>) {
    this.runCleanup = runCleanupLifetime(run);
    const directory = join(run.paths.privateDir, name);
    this.directory = directory;
    this.relativePath = `${name}/image.tar`;
    run.resources.register({ kind: 'private-dir', identity: this.directory, dispose: (deadline) => this.dispose(deadline) });
    this.created = (async () => {
      await safeDirectory(run.paths.privateDir);
      await mkdir(directory, { mode: 0o700 });
      const created = await lstat(directory);
      if (!created.isDirectory() || (created.mode & 0o777) !== 0o700 || (await readdir(directory)).length) archiveError();
      await safeDirectory(directory);
      const checked = await lstat(directory);
      if (checked.dev !== created.dev || checked.ino !== created.ino) archiveError();
      return created;
    })();
    void this.created.catch(() => {});
  }
  assertOpen(): void {
    checkCancelled(this.run.signal);
    if (this.state !== 'open' || this.runCleanup.deadline !== Infinity) throw failure(5, 'RUN_STOPPED', 'cleanup', 'The Docker build is already stopping.', 'Start a new run.');
  }
  runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.active) throw new Error('The archive already has a producer.');
    const active = (async () => { await this.created; this.assertOpen(); return operation(); })();
    this.active = active;
    return this.wait(active);
  }
  holdProcess(): () => void { this.assertOpen(); this.processHeld = true; return () => { this.processHeld = false; }; }
  private wait<T>(task: Promise<T>): Promise<T> { return this.cleanup.wait(this.runCleanup.wait(task)); }
  async stop(deadline: number): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'closing';
    this.cleanup.begin(Math.min(deadline, this.runCleanup.deadline));
    await this.wait(this.active?.catch(() => {}) ?? Promise.resolve());
    if (this.processHeld) throw failure(5, 'PROCESS_CLEANUP_FAILED', 'cleanup', 'The Docker archive producer or consumer did not stop.', 'Inspect the recorded process before cleaning this run.');
  }
  private async assertDirectory(): Promise<void> {
    const owned = await this.created;
    await safeDirectory(this.directory);
    const current = await lstat(this.directory);
    if (current.dev !== owned.dev || current.ino !== owned.ino) archiveError();
  }
  async validate(): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    const path = join(this.run.paths.privateDir, this.relativePath);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await file.stat();
      if (!initial.isFile() || initial.nlink !== 1 || initial.size < 1024 || initial.size % 512 !== 0) archiveError();
      const ending = Buffer.alloc(1024);
      const { bytesRead } = await file.read(ending, 0, ending.length, initial.size - ending.length);
      if (bytesRead !== ending.length || ending.some((byte) => byte !== 0)) archiveError();
      const named = await lstat(path);
      if (!named.isFile() || !sameFile(initial, await file.stat()) || !sameFile(initial, named)) archiveError();
      await this.assertDirectory();
      this.file = initial;
    } finally { await file.close(); }
    this.assertOpen();
  }
  async assertUnchanged(): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    const current = await lstat(join(this.run.paths.privateDir, this.relativePath));
    if (!this.file || !current.isFile() || !sameFile(this.file, current)) archiveError();
    this.assertOpen();
  }
  dispose(deadline: number): Promise<void> {
    if (this.state === 'disposed') return this.disposal!;
    this.cleanup.begin(Math.min(deadline, this.runCleanup.deadline));
    if (!this.disposal) this.disposal = (async () => {
      await this.stop(this.cleanup.deadline);
      await this.wait(this.created);
      this.cleanup.assertRemaining();
      this.runCleanup.assertRemaining();
      await this.wait(this.removeBuilder(Math.min(this.cleanup.deadline, this.runCleanup.deadline)));
      try { await this.wait(this.assertDirectory()); }
      catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
      await this.wait(rm(this.directory, { recursive: true }));
    })().then(() => {
      this.cleanup.assertRemaining();
      this.runCleanup.assertRemaining();
      this.state = 'disposed';
    }).finally(() => this.cleanup.finish());
    return this.disposal;
  }
}
