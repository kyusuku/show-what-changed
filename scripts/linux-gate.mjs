#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnvironment } from './git-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = ['src', 'test', 'fixtures', 'scripts', 'schema', 'assets', 'skills', 'docs', 'spec.md', 'evidence/revision-0.3-status.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.nvmrc', '.gitignore'];
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (['--snapshot', '--release', '--build'].includes(arg)) options[arg.slice(2)] = true;
  else if (['--commit', '--tarball', '--tarball-sha256', '--out'].includes(arg) && args[index + 1]) options[arg.slice(2)] = args[++index];
  else throw new Error(`Unsupported or missing Linux gate argument ${arg}.`);
}
if (Boolean(options.snapshot) === Boolean(options.commit) || !options.out || !isAbsolute(options.out)) throw new Error('Use exactly one of --snapshot or --commit SHA, and an absolute --out directory.');
if (options.release && (!options.commit || !options.tarball || !/^[a-f0-9]{64}$/.test(options['tarball-sha256'] ?? ''))) throw new Error('--release needs --commit, --tarball, and --tarball-sha256.');
if (!options.release && (options.tarball || options['tarball-sha256'])) throw new Error('Candidate tarball inputs require --release.');
const out = resolve(options.out);
await mkdir(out, { recursive: false });
const temp = await mkdtemp(join(tmpdir(), 'swc-linux-gate-'));
const name = `swc-v01-linux-${Date.now()}-${randomBytes(3).toString('hex')}`;
const image = 'swc-v01-linux-gate:node24.22.2-pw1.64.1-arm64-v1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const command = (argv, settings = {}) => new Promise((resolveCommand, reject) => {
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env: basename(argv[0]) === 'git' ? gitEnvironment() : { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit', ...settings });
  child.once('error', reject);
  child.once('close', (code, signal) => resolveCommand({ code, signal }));
});
const checked = async (argv) => { const result = await command(argv); if (result.code !== 0 || result.signal) throw new Error(`Command failed ${argv.join(' ')}`); };
let created = false;
try {
  const sourceArchive = join(temp, 'source.tar');
  let commit;
  if (options.commit) {
    if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('--commit requires a full lowercase SHA-1.');
    commit = execFileSync('git', ['rev-parse', '--verify', `${options.commit}^{commit}`], { cwd: root, env: gitEnvironment(), encoding: 'utf8' }).trim();
    await checked(['git', 'archive', '--format=tar', `--output=${sourceArchive}`, commit, ...sourcePaths]);
  } else {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnvironment(), encoding: 'utf8' }).trim();
    const source = join(temp, 'source');
    await mkdir(source);
    for (const path of sourcePaths) {
      try {
        await cp(join(root, path), join(source, path), { recursive: true, filter: (sourcePath) => !['node_modules', '.next', '.git', '.show-what-changed', '.env'].includes(sourcePath.split('/').at(-1)) });
      } catch (error) {
        if (error.code !== 'ENOENT' || path !== 'skills') throw error;
      }
    }
    await checked(['tar', '-cf', sourceArchive, '-C', source, '.']);
  }
  let tarballSha256 = null;
  if (options.tarball) {
    options.tarball = resolve(options.tarball);
    tarballSha256 = hash(await readFile(options.tarball));
    if (tarballSha256 !== options['tarball-sha256']) throw new Error('The supplied tarball does not match --tarball-sha256.');
  }
  const input = {
    mode: options.release ? 'release' : options.snapshot ? 'snapshot' : 'commit', commit,
    dirtySnapshot: Boolean(options.snapshot), sourceArchiveSha256: hash(await readFile(sourceArchive)),
    tarballSha256, tarballName: options.tarball ? options.tarball.split('/').at(-1) : null,
    platform: 'linux/arm64', image,
    runnerFiles: Object.fromEntries(await Promise.all(['linux-gate.mjs', 'linux-gate/Dockerfile', 'linux-gate/install-lsof.sh', 'linux-gate/container.mjs', 'linux-gate/sandbox-probe.mjs', 'linux-gate/seccomp.json'].map(async (path) => [path, hash(await readFile(join(root, 'scripts', path)))]))),
  };
  await writeFile(join(out, 'input.json'), JSON.stringify(input, null, 2) + '\n');
  await writeFile(join(temp, 'input.json'), JSON.stringify(input));
  await cp(sourceArchive, join(out, 'source.tar'));
  const present = execFileSync('docker', ['image', 'ls', '-q', image], { encoding: 'utf8' }).trim();
  const contextHash = hash(JSON.stringify(Object.entries(input.runnerFiles).filter(([path]) => ['linux-gate/Dockerfile', 'linux-gate/install-lsof.sh', 'linux-gate/container.mjs', 'linux-gate/sandbox-probe.mjs'].includes(path))));
  const imageContextHash = present ? JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0].Config.Labels?.['io.show-what-changed.linux-gate-context-sha256'] : null;
  if (options.build || contextHash !== imageContextHash) await checked(['docker', 'build', '--platform', 'linux/arm64', '--label', `io.show-what-changed.linux-gate-context-sha256=${contextHash}`, '--tag', image, join(root, 'scripts/linux-gate')]);
  const imageIdentity = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
  await writeFile(join(out, 'image.json'), JSON.stringify({ id: imageIdentity.Id, repoDigests: imageIdentity.RepoDigests, os: imageIdentity.Os, architecture: imageIdentity.Architecture, created: imageIdentity.Created }, null, 2) + '\n');
  const dockerInfo = execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' });
  const engine = JSON.parse(dockerInfo);
  await writeFile(join(out, 'engine.json'), JSON.stringify({ version: engine.ServerVersion, kernel: engine.KernelVersion, os: engine.OperatingSystem, architecture: engine.Architecture, cpus: engine.NCPU, memoryBytes: engine.MemTotal }, null, 2) + '\n');
  await checked(['docker', 'create', '--name', name, '--platform', 'linux/arm64', '--init', '--cpus=2', '--memory=3g', '--pids-limit=512', '--shm-size=512m', '--cap-drop=ALL', '--cap-add=SYS_CHROOT', '--security-opt=no-new-privileges', `--security-opt=seccomp=${join(root, 'scripts/linux-gate/seccomp.json')}`, imageIdentity.Id]);
  created = true;
  await checked(['docker', 'cp', sourceArchive, `${name}:/tmp/swc-source.tar`]);
  await checked(['docker', 'cp', join(temp, 'input.json'), `${name}:/tmp/swc-gate-input.json`]);
  if (options.tarball) await checked(['docker', 'cp', options.tarball, `${name}:/tmp/swc-candidate.tgz`]);
  const result = await command(['docker', 'start', '--attach', name]);
  await checked(['docker', 'cp', `${name}:/home/pwuser/gate-evidence/.`, out]);
  const state = JSON.parse(execFileSync('docker', ['inspect', name, '--format', '{{json .State}}'], { encoding: 'utf8' }));
  await writeFile(join(out, 'container-state.json'), JSON.stringify(state, null, 2) + '\n');
  if (result.code !== 0 || state.ExitCode !== 0 || state.OOMKilled) {
    const reportPath = join(out, 'result.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.status = 'failed';
    report.releaseGateComplete = false;
    report.containerFailure = { exitCode: state.ExitCode, oomKilled: state.OOMKilled, dockerClientExitCode: result.code, dockerClientSignal: result.signal };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`Linux gate evidence ${out}`);
  process.exitCode = result.code === 0 && state.ExitCode === 0 && !state.OOMKilled ? 0 : 1;
} finally {
  if (created) await command(['docker', 'rm', '--force', name]);
  await rm(temp, { recursive: true, force: true });
}
