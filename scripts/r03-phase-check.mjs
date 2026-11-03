#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compatibilityProfiles, prepareCompatibilityFixture } from './compatibility-smoke.mjs';
import { assertNoOwnedActivity, command, hash, installCandidate, saveJson, sourceState } from './release-harness.mjs';
import { checkMask, loadInstalled, mapRectangle, panelGeometry } from './revision-0.3-motion-check.mjs';

export const phaseCases = Object.freeze([
  { id: 'setup-deadline', phase: 'setup', stimulus: 'deadline', runSeconds: 8, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' },
  { id: 'startup-deadline', phase: 'startup', stimulus: 'deadline', runSeconds: 8, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' },
  { id: 'recording-sigint', phase: 'recording', stimulus: 'SIGINT', runSeconds: 60, exitCode: 130, errorCode: 'SIGINT' },
  { id: 'recording-sigterm', phase: 'recording', stimulus: 'SIGTERM', runSeconds: 60, exitCode: 143, errorCode: 'SIGTERM' },
  { id: 'recording-deadline', phase: 'recording', stimulus: 'deadline', runSeconds: 20, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' },
  { id: 'encoding-deadline', phase: 'encoding', stimulus: 'deadline', runSeconds: 60, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' },
  { id: 'setup-sigint', phase: 'setup', stimulus: 'SIGINT', runSeconds: 60, exitCode: 130, errorCode: 'SIGINT' },
  { id: 'setup-sigterm', phase: 'setup', stimulus: 'SIGTERM', runSeconds: 60, exitCode: 143, errorCode: 'SIGTERM' },
  { id: 'startup-sigint', phase: 'startup', stimulus: 'SIGINT', runSeconds: 60, exitCode: 130, errorCode: 'SIGINT' },
  { id: 'startup-sigterm', phase: 'startup', stimulus: 'SIGTERM', runSeconds: 60, exitCode: 143, errorCode: 'SIGTERM' },
  { id: 'encoding-sigint', phase: 'encoding', stimulus: 'SIGINT', runSeconds: 60, exitCode: 130, errorCode: 'SIGINT' },
  { id: 'encoding-sigterm', phase: 'encoding', stimulus: 'SIGTERM', runSeconds: 60, exitCode: 143, errorCode: 'SIGTERM' },
].map(Object.freeze));
const viewport = Object.freeze({ width: 320, height: 240 });
const mask = Object.freeze({ x: 0, y: 0, width: 140, height: 100 });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const inside = (root, path) => path === root || path.startsWith(root + '/');
const entries = async (path) => readdir(path).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
const usage = 'Usage: node scripts/r03-phase-check.mjs (--installed-root /package | --tarball /candidate.tgz) --output-dir /new/private-output --case CASE [--case CASE]';

export function phaseSelection(argv) {
  const options = { ids: [] };
  const keys = new Map([['--installed-root', 'installedRoot'], ['--tarball', 'tarball'], ['--output-dir', 'outputDir']]);
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]; assert(value && !value.startsWith('--'), usage);
    if (argv[i] === '--case') { assert(!options.ids.includes(value), usage); options.ids.push(value); continue; }
    const key = keys.get(argv[i]); assert(key && options[key] === undefined, usage); options[key] = value;
  }
  assert(Boolean(options.installedRoot) !== Boolean(options.tarball), usage);
  assert(options.outputDir && isAbsolute(options.outputDir) && options.ids.length, usage);
  for (const key of ['installedRoot', 'tarball']) if (options[key]) { assert(isAbsolute(options[key]), usage); options[key] = resolve(options[key]); }
  const cases = options.ids.map((id) => { const entry = phaseCases.find((row) => row.id === id); assert(entry, usage); return entry; });
  return { ...options, outputDir: resolve(options.outputDir), cases };
}

export async function interruptPhaseCommand({ argv, cwd, env = {}, entry, observe, phaseWaitMs = entry.stimulus === 'deadline' ? (entry.runSeconds + 35) * 1000 : 45_000 }) {
  const started = performance.now(), startedMonoNs = process.hrtime.bigint().toString();
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const reachLimitMs = Math.min(phaseWaitMs, entry.stimulus === 'deadline' ? entry.runSeconds * 1000 : 45_000);
  let settled = false, stopping = false, timedOut = false, overflow = false, bytes = 0, signalSent = null, marker = null, phaseReached = false;
  let exit = null, close = null, spawnError = null, finish;
  const output = { stdout: [], stderr: [] }, events = [];
  let hardTimer, closeTimer;
  const finished = new Promise((done) => { finish = (transportError = null) => {
    if (settled) return;
    settled = true;
    done({ code: close?.code ?? exit?.code ?? null, signal: close?.signal ?? exit?.signal ?? null, spawnError, exit, close, transportError });
  }; });
  const boundClose = () => { closeTimer ??= setTimeout(() => {
    finish(exit ? 'PIPE_CLOSE_TIMEOUT' : 'CHILD_EXIT_TIMEOUT');
    child.stdout.destroy(); child.stderr.destroy();
  }, 1000); };
  const stop = () => {
    if (settled || stopping || exit || spawnError) return;
    stopping = true;
    events.push({ at: new Date().toISOString(), kind: 'harness-stop', signal: 'SIGTERM', sent: child.kill('SIGTERM') });
    hardTimer = setTimeout(() => {
      if (!exit && !settled) events.push({ at: new Date().toISOString(), kind: 'harness-stop', signal: 'SIGKILL', sent: child.kill('SIGKILL') });
      boundClose();
    }, 12_000);
  };
  child.once('error', (error) => { spawnError = error.code ?? error.name; boundClose(); });
  child.once('exit', (code, signal) => { exit = { code, signal, observedElapsedMs: performance.now() - started, observedMonoNs: process.hrtime.bigint().toString() }; clearTimeout(hardTimer); boundClose(); });
  child.once('close', (code, signal) => { close = { code, signal, observedElapsedMs: performance.now() - started, observedMonoNs: process.hrtime.bigint().toString() }; finish(); });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 ** 2) { if (!overflow) stop(); overflow = true; }
    else output[stream].push(chunk);
  });
  const timer = setTimeout(() => { timedOut = true; stop(); }, (entry.runSeconds + 35) * 1000);
  let result, observationError;
  try {
    const ended = finished.then(() => null);
    while (!settled && !exit && !spawnError && performance.now() - started < reachLimitMs) {
      const observed = await Promise.race([observe({ pid: child.pid }), ended]);
      if (observed) {
        marker = { ...observed, observedAt: new Date().toISOString(), elapsedMs: performance.now() - started };
        phaseReached = !settled && !exit && !spawnError && marker.elapsedMs < reachLimitMs;
        if (phaseReached && entry.stimulus !== 'deadline') { assert(['SIGINT', 'SIGTERM'].includes(entry.stimulus)); if (child.kill(entry.stimulus)) signalSent = entry.stimulus; }
        break;
      }
      await delay(20);
    }
    if (!phaseReached && entry.stimulus !== 'deadline') stop();
    result = await finished;
  } catch (error) { observationError = error; }
  finally { clearTimeout(timer); if (!settled) stop(); result ??= await finished; clearTimeout(hardTimer); clearTimeout(closeTimer); }
  const probe = { ...result, startedMonoNs, phaseReached, marker, signalSent, timedOut, overflow, events, elapsedMs: performance.now() - started, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') };
  if (observationError) throw Object.assign(observationError, { probe });
  return probe;
}

export function assertPhaseResult(entry, probe, envelope) {
  assert(probe.phaseReached, 'PHASE_NOT_REACHED');
  assert(Number.isFinite(probe.marker?.elapsedMs) && probe.marker.elapsedMs >= 0 && probe.marker.elapsedMs < (entry.stimulus === 'deadline' ? entry.runSeconds * 1000 : 45_000), 'PHASE_NOT_REACHED_IN_TIME');
  assert(!probe.timedOut && !probe.events?.length, 'HARNESS_TIMEOUT');
  assert(!probe.overflow && !probe.spawnError && !probe.transportError && probe.signal === null, 'CLI_TRANSPORT_FAILED');
  assert.equal(probe.signalSent, entry.stimulus === 'deadline' ? null : entry.stimulus, 'Wrong external stimulus');
  if (entry.stimulus === 'deadline') assert(Number.isFinite(probe.exit?.observedElapsedMs) && probe.exit.observedElapsedMs >= entry.runSeconds * 1000, 'DEADLINE_TOO_EARLY');
  assert.equal(probe.code, entry.exitCode); assert.equal(envelope.exitCode, entry.exitCode);
  assert.equal(envelope.status, 'cancelled'); assert.equal(envelope.error?.code, entry.errorCode);
  assert(envelope.data && envelope.data.state === 'terminal', 'A reached phase requires a terminal manifest');
  assert.equal(envelope.data.status, envelope.status); assert.equal(envelope.data.exitCode, envelope.exitCode);
}

async function processTable(cwd) {
  const result = await command(['ps', '-axo', 'pid=,ppid=,pgid=,stat=,lstart='], cwd, { expectedCode: 0, timeoutMs: 5000 });
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    assert(parts.length >= 9 && parts.slice(0, 3).every((value) => /^\d+$/.test(value)), 'Invalid process identity response');
    return { pid: Number(parts[0]), parent: Number(parts[1]), group: Number(parts[2]), state: parts[3], started: parts.slice(4).join(' ') };
  });
}

export async function witnessPhaseProcess(record, cliPid, cwd) {
  assert(Number.isSafeInteger(record.pid) && record.pid > 0, 'Phase marker requires a process identity');
  const table = await processTable(cwd), live = table.filter((row) => !row.state.startsWith('Z'));
  const chain = [], seen = new Set(); let current = live.find((row) => row.pid === record.pid);
  while (current && !seen.has(current.pid)) {
    chain.push(current); seen.add(current.pid);
    if (current.pid === cliPid) break;
    current = live.find((row) => row.pid === current.parent);
  }
  assert(chain.at(-1)?.pid === cliPid, 'Phase process is not a live descendant of this CLI');
  const owned = new Set(chain.map(({ pid }) => pid));
  for (let changed = true; changed;) { changed = false; for (const row of live) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  const processes = live.filter(({ pid }) => owned.has(pid));
  const cliGroup = chain.at(-1).group;
  const groups = [...new Set(processes.filter((row) => row.group !== cliGroup && owned.has(row.group)).map(({ group }) => group))];
  return { observedAt: new Date().toISOString(), phasePid: record.pid, cliPid, processes, groups };
}

export async function assertWitnessInactive(witness, cwd) {
  assert(witness?.processes?.length, 'No independently observed phase process identity');
  const live = (await processTable(cwd)).filter((row) => !row.state.startsWith('Z'));
  for (const original of witness.processes) assert(!live.some((row) => row.pid === original.pid && row.started === original.started), 'Independently observed owned process remains alive');
  for (const group of witness.groups) assert(!live.some((row) => row.group === group), 'Independently observed owned process group remains alive');
  return { observedProcesses: witness.processes.length, observedGroups: witness.groups.length, status: 'absent' };
}

async function executable(name) {
  if (isAbsolute(name)) { await access(name, constants.X_OK); return realpath(name); }
  for (const directory of (process.env.PATH ?? '').split(':')) { try { const path = join(directory, name); await access(path, constants.X_OK); return await realpath(path); } catch {} }
  throw new Error('Required fixture executable is unavailable');
}

export async function preparePhaseFixture(entry, root) {
  assert(entry && phaseCases.some(({ id }) => id === entry.id));
  const fixture = await prepareCompatibilityFixture(compatibilityProfiles.find(({ name }) => name === 'static'), root);
  const server = join(root, 'phase-server.mjs'), setup = join(root, 'phase-setup.mjs');
  await writeFile(setup, `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';console.log(process.env.R8_CANARY);await writeFile(join(process.argv[2],'r8-phase.json'),JSON.stringify({phase:'setup',pid:process.pid,at:new Date().toISOString()}));setInterval(()=>{},1000);\n`, { mode: 0o600 });
  await writeFile(server, `import http from 'node:http';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const [port,state,phase]=process.argv.slice(2);console.log(process.env.R8_CANARY);if(phase==='startup'){await writeFile(join(state,'r8-phase.json'),JSON.stringify({phase:'startup',pid:process.pid,at:new Date().toISOString()}));setInterval(()=>{},1000)}else{const original=await readFile(join(process.cwd(),'index.html'),'utf8');http.createServer(async(req,res)=>{if(req.url==='/ready'){res.end('ready');return}if(req.url==='/r8-recording'){await writeFile(join(state,'r8-phase.json'),JSON.stringify({phase:'recording',pid:process.pid,at:new Date().toISOString()}));res.end('observed');return}res.setHeader('content-type','text/html');res.end('<style>body{margin:0}.private{position:fixed;left:0;top:0;width:140px;height:100px;overflow:hidden;background:red}.move{position:fixed;top:130px;width:20px;height:20px;background:lime;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(120px)}}</style><div class="private"><span>'+process.env.R8_CANARY+'</span><input data-testid="private" style="width:110px"></div><div class="move"></div><main style="margin-top:170px">'+original+'</main><script>document.querySelector("input").addEventListener("input",()=>requestAnimationFrame(()=>requestAnimationFrame(()=>fetch("/r8-recording"))))</script>')}).listen(Number(port),'127.0.0.1')}\n`, { mode: 0o600 });
  const configPath = join(root, 'phase.config.json');
  const inputs = [{ id: 'server', path: server }];
  if (entry.phase === 'setup') inputs.push({ id: 'setup', path: setup });
  await saveJson(configPath, { schemaVersion: 2, execution: {
    inputs, env: { R8_CANARY: { fromEnv: 'SWC_R8_CANARY' } },
    setup: entry.phase === 'setup' ? [{ argv: [process.execPath, '{input.setup}', '{stateDir}'], timeoutMs: 120_000 }] : [],
    start: { kind: 'process', argv: [process.execPath, '{input.server}', '{port}', '{stateDir}', entry.phase] },
    ready: { path: '/ready', timeoutMs: 120_000 }, state: { kind: 'stateless' },
  }, routes: { include: ['/'] }, capture: { mode: 'motion', viewport, maskRects: [mask], stepTimeoutMs: 30_000, observeMs: 200, maxScenarioMs: 60_000 } });
  const fillValue = 'PRIVATE_FILL_' + randomBytes(16).toString('hex');
  await saveJson(fixture.scenarioPath, { schemaVersion: 2, id: 'phase', title: 'Public bounded phase fixture', steps: [
    { id: 'open', op: 'goto', path: '/' }, { id: 'private-fill', op: 'fill', target: { testId: 'private' }, value: fillValue },
    ...(entry.phase === 'recording' ? [{ id: 'pending', op: 'expectVisible', target: { testId: 'never-ready' }, timeoutMs: 30_000 }] : [{ id: 'observe', op: 'screenshot', observeMs: 200 }]),
  ] });
  let ffmpeg;
  if (entry.phase === 'encoding') {
    const real = await executable(process.env.SWC_FFMPEG ?? 'ffmpeg'); ffmpeg = join(root, 'bounded-encoder.mjs');
    await writeFile(ffmpeg, String.raw`#!${process.execPath}
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2),target=args.some(value=>value.endsWith('/001-encode.mp4'));
const child=spawn(${JSON.stringify(real)},target?['-progress','pipe:3','-stats_period','0.1',...args]:args,{stdio:target?['pipe','inherit','inherit','pipe']:['inherit','inherit','inherit']});
child.once('error',()=>process.exit(1));child.once('exit',(code)=>process.exit(code??1));
if(target){
  let sent=0,marked=false,progress='',fields={};
  child.stdio[3].on('data',chunk=>{
    progress+=chunk.toString('utf8');if(progress.length>8192)throw new Error('Oversized encoder progress record');
    let newline;while((newline=progress.indexOf('\n'))!==-1){
      const line=progress.slice(0,newline).trim();progress=progress.slice(newline+1);const equals=line.indexOf('=');
      if(equals!==-1)fields[line.slice(0,equals)]=line.slice(equals+1);
      if(line.startsWith('progress=')){
        const frames=Number(fields.frame),outputTimeUs=Number(fields.out_time_us);
        if(!marked&&frames>0&&outputTimeUs>0){marked=true;writeFileSync('private/r8-encode.json',JSON.stringify({phase:'encoding',at:new Date().toISOString(),pid:child.pid,encodedFrames:frames,outputTimeUs,submittedBytes:sent,progressSource:'real-encoder-pipe:3'}))}
        fields={};
      }
    }
  });
  process.stdin.on('data',chunk=>{process.stdin.pause();sent+=chunk.length;const writable=child.stdin.write(chunk);const resume=()=>{if(marked)setTimeout(()=>process.stdin.resume(),250);else process.stdin.resume()};if(writable)resume();else child.stdin.once('drain',resume)});
  process.stdin.once('end',()=>child.stdin.end());child.stdin.on('error',()=>{});
}
`, { mode: 0o700 });
    await chmod(ffmpeg, 0o700);
  }
  return { ...fixture, configPath, fillValue, ffmpeg };
}

async function observedPhase(runDir, entry) {
  if (entry.phase === 'encoding') {
    const record = await phaseRecord(join(runDir, 'private/r8-encode.json'));
    if (!record || record.phase !== 'encoding' || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !(record.encodedFrames > 0 && record.outputTimeUs > 0 && record.submittedBytes > 0 && record.progressSource === 'real-encoder-pipe:3')) return null;
    const live = await command(['ps', '-p', String(record.pid), '-o', 'pid=,comm='], runDir, { timeoutMs: 5000 });
    assert(live.code === 0 && /ffmpeg/i.test(live.stdout), 'A real encoder must be alive after reporting an encoded frame');
    return record;
  }
  const parent = join(runDir, 'private/execution/before');
  for (const name of await entries(parent)) {
    if (!/^[a-f0-9]{16}$/.test(name)) continue;
    const record = await phaseRecord(join(parent, name, 'state/r8-phase.json'));
    if (record?.phase !== entry.phase) continue;
    if (entry.phase === 'recording') {
      const checkpointPath = 'frames/001-before.png'; // Second fixture action is the private fill.
      try { await access(join(runDir, checkpointPath)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      record.checkpointPath = checkpointPath;
    }
    return record;
  }
  return null;
}

async function phaseRecord(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function pngAt(path, PNG, width, height) {
  const info = await stat(path); assert(info.isFile() && info.size >= 24 && info.size <= 16 * 1024 ** 2, 'Bounded PNG required');
  const bytes = await readFile(path);
  assert(bytes.length >= 24 && bytes.length <= 16 * 1024 ** 2 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Bounded PNG required');
  assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
  return PNG.sync.read(bytes, { checkCRC: true });
}

function checkColor(image, rectangle, color, tolerance = 0) {
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
    const offset = (y * image.width + x) * 4;
    assert.equal(image.data[offset + 3], 255, 'Inspected output must be opaque');
    for (let channel = 0; channel < 3; channel++) assert(Math.abs(image.data[offset + channel] - color[channel]) <= tolerance, 'Inspected panel differs from its safe color');
  }
}

export async function verifyPersistedMasks(runDir, PNG, size = viewport, rectangle = mask, neutral = new Set()) {
  const files = (await entries(join(runDir, 'frames'))).filter((name) => name.endsWith('.png')).sort();
  assert(files.length <= 12_000); let neutralImages = 0;
  for (const name of files) {
    const image = await pngAt(join(runDir, 'frames', name), PNG, size.width, size.height);
    if (neutral.has('frames/' + name)) { checkColor(image, { x: 0, y: 0, ...size }, [32, 36, 44]); neutralImages++; }
    else checkMask(image, rectangle);
  }
  return { checkedImages: files.length, ...(neutralImages ? { neutralImages } : {}) };
}

async function recordingFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Unexpected symlink in phase evidence');
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await recordingFiles(join(directory, entry.name), path + '/'));
    else { assert(!/\.(?:webm|raw|rgba|yuv)$/i.test(entry.name), 'Raw recording file is forbidden'); if (/\.mp4$/i.test(entry.name) || path === 'poster.png') result.push({ path, bytes: (await stat(join(directory, entry.name))).size }); }
  }
  assert(result.length <= 4, 'Unexpected number of retained media files'); return result;
}

async function boundPresentation(runDir, manifest, candidate) {
  assert(candidate.validateTimelineCapture, 'Retained application media requires independently bound capture and timeline');
  const capture = candidate.schemas.CaptureBundleSchema.parse(JSON.parse(await readFile(join(runDir, 'capture.json'), 'utf8')));
  const timeline = candidate.schemas.TimelineSchema.parse(JSON.parse(await readFile(join(runDir, 'timeline.json'), 'utf8')));
  candidate.validateTimelineCapture(timeline, capture);
  assert.equal(timeline.runId, manifest.runId); assert.deepEqual(timeline.viewport, { ...viewport, deviceScaleFactor: 1 });
  for (const artifact of timeline.images) { const path = resolve(runDir, artifact.path); assert(inside(runDir, path)); const bytes = await readFile(path); assert.equal(bytes.length, artifact.bytes); assert.equal(hash(bytes), artifact.sha256); }
  return { capture, timeline };
}

function checkSelectedPanels(image, selection, decoded) {
  for (const side of ['before', 'after']) {
    const rectangle = mapRectangle(mask, panelGeometry(viewport, side), decoded ? 4 : 0);
    if (selection[side]) checkMask(image, rectangle, decoded);
    else checkColor(image, rectangle, [15, 23, 42], decoded ? 24 : 0);
  }
}

export async function inspectRetainedImages(runDir, manifest, candidate) {
  const paths = [];
  const visit = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Unexpected retained image symlink');
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
      else if (/\.png$/i.test(entry.name)) { paths.push(path); assert(paths.length <= 13_000, 'Retained image count exceeded'); }
    }
  };
  await visit(runDir);
  const result = { inventoried: paths.length, sourceFrames: 0, composedCheckpoints: 0, transparentOverlays: 0, decodedBoundaries: 0, posters: 0, nonAppTitleImages: 0, scope: 'private rectangle pixels in every retained app-bearing PNG; title cards are classified by trusted bound presentation, not arbitrary-content detection' };
  const other = paths.filter((path) => !/^frames\/[^/]+\.png$/.test(path));
  result.sourceFrames = paths.length - other.length;
  if (!other.length) return result;
  const { capture, timeline } = await boundPresentation(runDir, manifest, candidate);
  const table = new Map(timeline.images.map((artifact) => [artifact.path, artifact]));
  const stepImages = timeline.images.filter(({ path }) => /^composed\/\d{3}-step\.png$/.test(path)).sort((a, b) => a.path.localeCompare(b.path));
  const steps = capture.scenarios.flatMap((scenario) => scenario.steps);
  assert.equal(stepImages.length, steps.length, 'Every composed checkpoint needs its capture step');
  for (const path of other) {
    if (path === 'poster.png') { result.posters++; continue; } // Inspected by retained media, including unreferenced posters.
    const image = await pngAt(join(runDir, path), candidate.PNG, 1920, 686);
    const stepIndex = stepImages.findIndex((artifact) => artifact.path === path);
    if (stepIndex !== -1) {
      for (const side of ['before', 'after']) { const rectangle = mapRectangle(mask, panelGeometry(viewport, side)); if (steps[stepIndex][side].imageKind === 'neutral') checkColor(image, rectangle, [32, 36, 44]); else checkMask(image, rectangle); }
      result.composedCheckpoints++; continue;
    }
    if (/^composed\/\d{3}-overlay\.png$/.test(path) && table.has(path) && timeline.selections.some((selection) => selection.overlay === path)) {
      for (const side of ['before', 'after']) { const rectangle = mapRectangle(mask, panelGeometry(viewport, side)); for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) assert.equal(image.data[(y * 1920 + x) * 4 + 3], 0, 'Overlay must not obscure the safe source rectangle'); }
      result.transparentOverlays++; continue;
    }
    if (timeline.segments.some((segment) => segment.kind === 'title' && segment.image === path)) { result.nonAppTitleImages++; continue; }
    const boundary = /^private\/decoded-boundary-(\d+)\.png$/.exec(path);
    if (boundary) {
      const frame = Number(boundary[1]), selection = timeline.selections.find((entry) => entry.frame === frame);
      if (selection) checkSelectedPanels(image, selection, true);
      else { assert(timeline.segments.some((segment) => segment.kind === 'title' && frame >= segment.startFrame && frame < segment.startFrame + segment.durationFrames), 'Unbound decoded boundary'); result.nonAppTitleImages++; }
      result.decodedBoundaries++; continue;
    }
    throw new Error('Unrecognized retained PNG requires inspection');
  }
  return result;
}

export async function inspectRetainedMedia(runDir, manifest, candidate) {
  const inventory = await recordingFiles(runDir);
  await saveJson(join(runDir, 'private/r8-retained-media.json'), inventory);
  for (const file of inventory) assert(['private/000-capability.mp4', 'private/001-encode.mp4', 'compare.mp4', 'poster.png'].includes(file.path), 'Unrecognized retained media requires separate inspection');
  for (const kind of ['video', 'poster']) if (manifest.artifacts[kind]) assert(inventory.some(({ path }) => path === manifest.artifacts[kind].path), 'Referenced media is missing');
  const applicationMedia = inventory.filter(({ path }) => path !== 'private/000-capability.mp4');
  let capture, timeline;
  if (applicationMedia.length) {
    ({ capture, timeline } = await boundPresentation(runDir, manifest, candidate));
  }
  const result = { status: inventory.length ? 'inspected' : 'none-present', scope: 'known synthetic private rectangle, neutral panels, and capability pixels; no whole-image secret detection claim', files: [] };
  for (const file of inventory) {
    const row = { ...file }; result.files.push(row);
    if (!file.bytes) { row.status = 'empty-placeholder'; assert(!manifest.artifacts.video || file.path !== manifest.artifacts.video.path, 'Published video is empty'); continue; }
    if (file.path === 'poster.png') {
      const expected = timeline.images.find(({ path }) => path === timeline.poster); assert(expected);
      assert.equal(hash(await readFile(join(runDir, file.path))), expected.sha256, 'Poster differs from bound capture presentation');
      const selected = timeline.posterSelection;
      const scenario = capture.scenarios.find(({ id }) => id === selected.scenarioId) ?? capture.scenarios[0];
      const step = scenario.steps.find(({ id }) => id === selected.stepId) ?? scenario.steps[0];
      const image = await pngAt(join(runDir, file.path), candidate.PNG, 1920, 686);
      for (const side of ['before', 'after']) { const rectangle = mapRectangle(mask, panelGeometry(viewport, side)); if (step[side].imageKind === 'neutral') checkColor(image, rectangle, [32, 36, 44]); else checkMask(image, rectangle); }
      row.status = 'mask-checked-poster'; continue;
    }
    const capability = file.path === 'private/000-capability.mp4', totalFrames = capability ? 2 : timeline.totalFrames;
    const directory = join(runDir, 'private/r8-decoded-' + result.files.length); await mkdir(directory);
    const decoded = await command([await executable(process.env.SWC_FFMPEG ?? 'ffmpeg'), '-v', 'error', '-threads', '2', '-i', join(runDir, file.path), '-threads', '2', '-fps_mode', 'passthrough', '-frames:v', String(totalFrames + 1), join(directory, '%06d.png')], runDir, { timeoutMs: 120_000 });
    await saveJson(join(runDir, 'private/r8-decode-' + result.files.length + '.json'), decoded);
    const files = (await readdir(directory)).sort(); row.decodedFrames = files.length;
    if (decoded.code !== 0 || decoded.signal || files.length === 0) { row.status = 'undecodable-present'; await saveJson(join(runDir, 'private/r8-media-inspection.json'), result); throw new Error('Present retained media could not be inspected'); }
    assert(files.length <= totalFrames, 'Unexpected extra encoded frames');
    const selections = new Map((timeline?.selections ?? []).map((selection) => [selection.frame, selection])); let checkedPanels = 0, titleFrames = 0;
    for (let frame = 0; frame < files.length; frame++) {
      const image = await pngAt(join(directory, files[frame]), candidate.PNG, 1920, 686);
      if (capability) checkColor(image, { x: 0, y: 0, width: 1920, height: 686 }, [72, 76, 85], 24);
      else {
        const selection = selections.get(frame);
        if (selection) { checkSelectedPanels(image, selection, true); checkedPanels += 2; }
        else { assert(timeline.segments.some((segment) => segment.kind === 'title' && frame >= segment.startFrame && frame < segment.startFrame + segment.durationFrames), 'Frame has no trusted capture selection'); titleFrames++; }
      }
      await rm(join(directory, files[frame]));
    }
    await rmdir(directory);
    row.status = files.length === totalFrames ? 'decoded-complete' : 'decoded-partial'; row.checkedPanels = checkedPanels; row.titleFrames = titleFrames; row.tolerancePerChannel = 24;
    if (capability || file.path === 'compare.mp4') assert.equal(files.length, totalFrames, 'Complete media must decode every expected frame');
  }
  return result;
}

async function sentinel(root) {
  const child = spawn(process.execPath, ['-e', "process.on('message',value=>process.send(value));process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)"], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise((done) => child.once('close', done));
  const identity = async () => (await command(['ps', '-p', String(child.pid), '-o', 'pid=,pgid=,lstart='], root, { expectedCode: 0, timeoutMs: 5000 })).stdout.trim();
  const close = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(timer); };
  try {
    const before = await identity();
    const check = async () => {
      assert(child.exitCode === null && child.signalCode === null && await identity() === before, 'Unrelated process identity changed');
      const value = randomBytes(16).toString('hex');
      await new Promise((done, reject) => { const listener = (received) => { clearTimeout(timer); if (received === value) done(); else reject(new Error('Unexpected sentinel response')); }; const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Unrelated sentinel stopped answering')); }, 2000); child.once('message', listener); child.send(value); });
    };
    await check(); return { check, close };
  } catch (error) { await close(); throw error; }
}

export async function runPhaseCase(entry, candidate, directory) {
  await mkdir(directory);
  const fixture = await preparePhaseFixture(entry, directory), original = await sourceState(fixture.repo), unrelated = await sentinel(directory);
  const canary = 'SYNTHETIC_PHASE_' + randomBytes(16).toString('hex');
  const env = { SWC_R8_CANARY: canary, ...(fixture.ffmpeg ? { SWC_FFMPEG: fixture.ffmpeg } : {}) };
  const row = { id: entry.id, phase: entry.phase, stimulus: entry.stimulus, status: 'failed', evidence: candidate.evidenceClass ?? 'installed-cli-with-public-fixture', runSeconds: entry.runSeconds, callerPreserved: false, sentinelPreserved: false, cleanup: 'unverified', errors: [] };
  let runDir, probe, witness, stage = 'plan';
  const failure = (code) => { row.errors.push({ code, stage }); };
  try {
    const plan = await command([process.execPath, candidate.binary, 'plan', '--base', fixture.base, '--head', fixture.head, '--config', fixture.configPath, '--scenario', fixture.scenarioPath, '--json'], fixture.repo, { expectedCode: 0, env, timeoutMs: 30_000 });
    await saveJson(join(directory, 'plan-command.json'), plan);
    const planned = candidate.schemas.ResultSchema.parse(JSON.parse(plan.stdout)); assert.equal(planned.data.baseCommit, fixture.base); assert.equal(planned.data.headCommit, fixture.head);
    row.plan = { planId: planned.data.planId, configDigest: planned.data.configDigest, scenarioDigest: planned.data.scenarioDigest };
    stage = 'phase';
    probe = await interruptPhaseCommand({ argv: [process.execPath, candidate.binary, 'compare', '--plan', '.show-what-changed/plan.json', '--allow-exec', '--timeout', String(entry.runSeconds), '--json'], cwd: fixture.repo, env, entry,
      observe: async ({ pid }) => {
        const ids = await entries(join(fixture.repo, '.show-what-changed/runs'));
        assert(ids.length <= 1 && ids.every((id) => /^\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(id)), 'Unexpected phase run identity');
        if (!ids.length) return null;
        runDir = join(fixture.repo, '.show-what-changed/runs', ids[0]);
        const record = await observedPhase(runDir, entry); if (!record) return null;
        witness = await witnessPhaseProcess(record, pid, directory);
        return { ...record, processWitness: witness };
      } });
    await saveJson(join(directory, 'comparison-command.json'), probe);
    row.phaseReached = probe.phaseReached; row.elapsedMs = probe.elapsedMs; row.actualExit = probe.code;
    assert(probe.phaseReached, 'PHASE_NOT_REACHED'); stage = 'result';
    assert.equal(probe.stdout.trim().split('\n').length, 1, 'Exactly one JSON envelope is required');
    const envelope = candidate.schemas.ResultSchema.parse(JSON.parse(probe.stdout)); assertPhaseResult(entry, probe, envelope);
    const manifest = candidate.schemas.ManifestSchema.parse(envelope.data); assert.equal(manifest.cleanupOutcome.status, 'ok'); assert.deepEqual(JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')), manifest);
    for (const artifact of Object.values(manifest.artifacts)) if (artifact) { const path = resolve(runDir, artifact.path); assert(inside(runDir, path)); const bytes = await readFile(path); assert.equal(bytes.length, artifact.bytes); assert.equal(hash(bytes), artifact.sha256); }
    stage = 'privacy';
    const text = [probe.stdout, probe.stderr];
    for (const file of ['manifest.json', 'capture.json', 'timeline.json', 'pr.md']) text.push(await readFile(join(runDir, file), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }));
    assert(!text.join('\n').includes(directory), 'Private fixture path appeared in public output');
    for (const name of await readdir(join(runDir, 'private'))) if (name.endsWith('.log')) text.push(await readFile(join(runDir, 'private', name), 'utf8'));
    for (const secret of [canary, fixture.fillValue]) assert(!text.join('\n').includes(secret), 'Synthetic private input escaped masking/redaction');
    const capture = await readFile(join(runDir, 'capture.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (capture) candidate.schemas.CaptureBundleSchema.parse(capture);
    if (entry.phase === 'recording') {
      const filled = capture?.scenarios.find(({ id }) => id === 'phase')?.steps.find(({ id }) => id === 'private-fill')?.before;
      assert(filled?.status === 'ok' && filled.imageKind === 'checkpoint' && filled.image.path === probe.marker.checkpointPath, 'Recording interruption requires a retained post-fill checkpoint');
      row.postFillCheckpoint = true;
    }
    const neutral = new Set(capture?.scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => ['before', 'after'].filter((side) => step[side].imageKind === 'neutral').map((side) => step[side].image.path))) ?? []);
    row.sourceMasks = await verifyPersistedMasks(runDir, candidate.PNG, viewport, mask, neutral);
    if (['recording', 'encoding'].includes(entry.phase)) assert(row.sourceMasks.checkedImages > 0, 'Reached capture phase must retain inspected safe frames');
    row.retainedImages = await inspectRetainedImages(runDir, manifest, candidate);
    row.mediaInspection = await inspectRetainedMedia(runDir, manifest, candidate); row.rawRecordingFilesAbsent = true;
    row.expectedInterruption = { status: envelope.status, exitCode: envelope.exitCode, errorCode: envelope.error.code };
    if (entry.phase === 'encoding') row.encoder = { kind: 'real-ffmpeg-with-controlled-input-pace', reportedEncodedFrames: probe.marker.encodedFrames, reportedOutputTimeUs: probe.marker.outputTimeUs, phaseEvidence: 'encoder-progress-pipe' };
  } catch (error) { if (error.probe) { probe = error.probe; await saveJson(join(directory, 'comparison-command.json'), probe); } failure(error.message === 'PHASE_NOT_REACHED' ? 'PHASE_NOT_REACHED' : 'PHASE_CHECK_FAILED'); await saveJson(join(directory, 'failure.json'), { name: error.name, message: error.message, code: error.code, stage }); }
  finally {
    stage = 'cleanup';
    try { assert(runDir, 'No run was registered'); if (witness) row.independentProcesses = await assertWitnessInactive(witness, directory); else row.independentProcesses = { status: 'phase-not-observed' }; row.cleanupDetails = await assertNoOwnedActivity(runDir); await assert.rejects(access(join(runDir, 'private/workspaces')), { code: 'ENOENT' }); row.cleanup = 'ok'; } catch (error) { failure('PHASE_CLEANUP_FAILED'); await saveJson(join(directory, 'cleanup-failure.json'), { name: error.name, message: error.message, code: error.code }); }
    stage = 'preservation';
    try { assert.deepEqual(await sourceState(fixture.repo), original); row.callerPreserved = true; row.callerStateSha256 = hash(JSON.stringify(original)); } catch { failure('CALLER_CHANGED'); }
    try { await unrelated.check(); row.sentinelPreserved = true; } catch { failure('UNRELATED_SENTINEL_CHANGED'); }
    await unrelated.close();
  }
  if (!row.errors.length) row.status = 'passed'; return row;
}

export async function verifyInstalledPhases(options) {
  assert.match(process.version, /^v24\./);
  assert(Array.isArray(options.cases) && options.cases.length && options.cases.every((entry) => phaseCases.includes(entry)) && new Set(options.cases).size === options.cases.length, usage);
  assert(Boolean(options.installedRoot) !== Boolean(options.tarball), usage);
  const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  options = { ...options, outputDir: join(await realpath(dirname(options.outputDir)), basename(options.outputDir)), ...(options.installedRoot ? { installedRoot: await realpath(options.installedRoot) } : {}) };
  assert(!inside(repository, options.outputDir), 'Private evidence must be outside the source repository');
  if (options.installedRoot) assert(!inside(options.installedRoot, options.outputDir), 'Evidence must be outside the installed package');
  await mkdir(options.outputDir); const privateDir = join(options.outputDir, 'private'); await mkdir(privateDir, { mode: 0o700 });
  const report = { schemaVersion: 1, specRevision: '0.3', scope: 'selected-installed-phase-cells', gateComplete: false, status: 'failed', platform: process.platform, arch: process.arch, node: process.version, harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceBinding: 'external-source-binding-required', requested: options.cases.map(({ id }) => id), pending: options.cases.map(({ id }) => id), cases: [], startedAt: new Date().toISOString() };
  try {
    const installed = options.tarball ? await installCandidate(options.tarball, privateDir, privateDir) : null;
    const root = await realpath(installed?.packageRoot ?? options.installedRoot), api = await loadInstalled(root);
    report.package = { ...api.identity, ...(installed ? { archiveSha256: installed.sha256, archiveBytes: installed.bytes } : {}) };
    const candidate = { binary: join(root, 'dist/cli/index.js'), schemas: api.schema, PNG: api.PNG, validateTimelineCapture: api.validateTimelineCapture };
    for (const entry of options.cases) { const result = await runPhaseCase(entry, candidate, join(privateDir, entry.id)); report.cases.push(result); report.pending = report.pending.filter((id) => id !== entry.id); await saveJson(join(options.outputDir, 'report.json'), report); }
    assert.equal((await loadInstalled(root)).identity.packageFilesSha256, api.identity.packageFilesSha256, 'Installed package changed during verification');
    if (report.cases.every(({ status }) => status === 'passed')) report.status = 'passed';
  } catch (error) { report.error = { code: 'PHASE_RUNNER_FAILED' }; await saveJson(join(privateDir, 'runner-failure.json'), { name: error.name, message: error.message, code: error.code }); }
  finally { report.endedAt = new Date().toISOString(); await saveJson(join(options.outputDir, 'report.json'), report); }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const report = await verifyInstalledPhases(phaseSelection(process.argv.slice(2))); process.stdout.write(JSON.stringify({ status: report.status, gateComplete: false, report: 'report.json' }) + '\n'); if (report.status !== 'passed') process.exitCode = 1; }
  catch { process.stderr.write(usage + '\n'); process.exitCode = 2; }
}
