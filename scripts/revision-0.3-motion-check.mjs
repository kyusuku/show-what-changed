import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sides = ['before', 'after'];
export const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];
const mask = { x: 0, y: 0, width: 140, height: 100 };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (bytes) => ({ sha256: digest(bytes), bytes: bytes.length });
const contains = (root, target) => {
  const path = relative(root, target);
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};

export function parseArguments(argv) {
  const options = { repetitions: 3 };
  const keys = new Map([['--installed-root', 'installedRoot'], ['--output-dir', 'outputDir'], ['--repetitions', 'repetitions']]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    assert(key && !seen.has(key) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Expected unique --installed-root, --output-dir, and optional --repetitions arguments');
    seen.add(key);
    options[key] = argv[index + 1];
  }
  assert(typeof options.installedRoot === 'string' && isAbsolute(options.installedRoot), '--installed-root must be an absolute installed package directory');
  assert(typeof options.outputDir === 'string' && isAbsolute(options.outputDir), '--output-dir must be an absolute new directory');
  assert(/^[1-3]$/.test(String(options.repetitions)), '--repetitions must be 1, 2, or 3');
  return { ...options, repetitions: Number(options.repetitions) };
}

export function panelGeometry(viewport, side) {
  assert(sides.includes(side));
  const scale = Math.min(1, 958 / viewport.width, 598 / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * scale));
  const height = Math.max(1, Math.floor(viewport.height * scale));
  return {
    x: (side === 'before' ? 0 : 962) + Math.floor((958 - width) / 2),
    y: 48 + Math.floor((598 - height) / 2), width, height,
    scaleX: width / viewport.width, scaleY: height / viewport.height,
  };
}

export function mapRectangle(rectangle, geometry, inset = 0) {
  const x = geometry.x + Math.ceil(rectangle.x * geometry.scaleX) + inset;
  const y = geometry.y + Math.ceil(rectangle.y * geometry.scaleY) + inset;
  const right = geometry.x + Math.floor((rectangle.x + rectangle.width) * geometry.scaleX) - inset;
  const bottom = geometry.y + Math.floor((rectangle.y + rectangle.height) * geometry.scaleY) - inset;
  assert(right > x && bottom > y, 'The mapped rectangle must have an interior');
  return { x, y, width: right - x, height: bottom - y };
}

export function checkMask(image, rectangle, decoded = false) {
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++)
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
      const p = (y * image.width + x) * 4;
      assert.equal(image.data[p + 3], 255, 'Every checked mask pixel must be opaque');
      for (let channel = 0; channel < 3; channel++)
        assert(decoded ? Math.abs(image.data[p + channel] - 16) <= 24 : image.data[p + channel] === 16,
          decoded ? 'Decoded mask interior exceeds the codec tolerance' : 'Persisted source mask differs from opaque #101010');
    }
}

export function observe(image, rectangle, color) {
  let xSum = 0;
  let pixels = 0;
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++)
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
      const p = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(p, p + 3);
      const matches = color === 'mover' ? g > 180 && r < 80 && b < 80
        : color === 'native' ? r > 180 && g > 90 && g < 200 && b < 100
          : r > 180 && b > 180 && g < 80;
      if (matches) { xSum += x; pixels++; }
    }
  return { x: pixels ? Math.round(xSum / pixels * 10) / 10 : null, pixels };
}

export function movingMetrics(observations, startMs, durationMs = 3000) {
  const moving = observations.filter((entry) => entry.runElapsedMs >= startMs && entry.runElapsedMs <= startMs + durationMs);
  const times = [startMs, ...moving.map((entry) => entry.runElapsedMs), startMs + durationMs];
  return {
    positions: moving.filter((entry) => entry.x !== null),
    distinctPositions: new Set(moving.filter((entry) => entry.x !== null).map((entry) => entry.x)).size,
    maxMovingGapMs: Math.max(...times.slice(1).map((time, index) => time - times[index])),
  };
}

export function bluePixels(image, rectangle) {
  let count = 0;
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++)
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
      const p = (y * image.width + x) * 4;
      if (image.data[p] < 150 && image.data[p + 1] > 140 && image.data[p + 2] > 190) count++;
    }
  return count;
}

export function fixtureHtml(original, viewport) {
  const travel = Math.min(600, viewport.width - 70);
  const style = `<style>.mover,.native{left:20px}.pulse{left:${viewport.width - 110}px}button{left:160px}.scroll{left:20px;width:${viewport.width - 40}px}.running .native{transform:translateX(${travel}px)}@keyframes travel{from{transform:translateX(0)}to{transform:translateX(${travel}px)}}</style>`;
  assert(original.includes('</head>') && original.includes('Start motion') && original.includes('inner-scroll'));
  return original.replace('</head>', style + '</head>');
}

async function existingDirectory(path) {
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Input must be a real directory');
  return realpath(path);
}

async function newOutput(path, installedRoot) {
  path = resolve(path);
  assert(!contains(installedRoot, path), 'Output must be outside the installed package');
  const missing = [];
  let ancestor = path;
  while (true) {
    try {
      const info = await lstat(ancestor);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Output ancestors must be real directories');
      if (ancestor === path) throw new Error('Output directory already exists');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(ancestor);
      ancestor = dirname(ancestor);
    }
  }
  let checked = ancestor;
  while (dirname(checked) !== checked) {
    const info = await lstat(checked);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Output ancestors must not contain symlinks');
    checked = dirname(checked);
  }
  for (const directory of missing.reverse()) await mkdir(directory, { mode: 0o700 });
  return path;
}

export async function loadInstalled(root) {
  const require = createRequire(join(root, 'package.json'));
  const packageBytes = await readFile(join(root, 'package.json'));
  const metadata = JSON.parse(packageBytes);
  assert.equal(metadata.name, 'show-what-changed');
  const dependencyVersions = {};
  for (const [name, expected] of Object.entries(metadata.dependencies)) {
    assert(/^\d+\.\d+\.\d+$/.test(expected), `Dependency ${name} must have an exact version`);
    let directory = dirname(await realpath(require.resolve(name)));
    let dependency;
    while (true) {
      try {
        dependency = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (dependency.name === name) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.notEqual(dirname(directory), directory, `Missing installed dependency ${name}`);
      directory = dirname(directory);
    }
    assert.equal(dependency.version, expected, `Installed dependency ${name} must match the package pin`);
    dependencyVersions[name] = expected;
  }
  const paths = ['dist/recorder/index.js', 'dist/composer/index.js', 'dist/runtime/context.js', 'dist/runtime/process-table.js', 'dist/schema/index.js'];
  const modules = {};
  const hashes = {};
  for (const path of paths) {
    const full = await realpath(join(root, path));
    assert(contains(root, full), 'Installed modules must remain inside the supplied package');
    hashes[path] = identity(await readFile(full));
    modules[path] = await import(pathToFileURL(full).href);
  }
  const packageFiles = [];
  const walk = async (directory, prefix = '') => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === 'node_modules') continue;
      assert(name !== '.git' && name !== 'src', 'Supply a clean installed package, not the development checkout');
      const path = join(directory, name);
      const info = await lstat(path);
      assert(!info.isSymbolicLink(), 'Installed package files must not be symlinks');
      if (info.isDirectory()) await walk(path, prefix + name + '/');
      else {
        assert(info.isFile(), 'Installed package entries must be regular files');
        packageFiles.push({ path: prefix + name, ...identity(await readFile(path)) });
      }
    }
  };
  await walk(root);
  const playwrightCore = dirname(require.resolve('playwright-core/package.json'));
  const browserMetadata = JSON.parse(await readFile(join(playwrightCore, 'browsers.json'), 'utf8'));
  return {
    capture: modules[paths[0]].capture,
    ...modules[paths[1]], ...modules[paths[2]],
    groupMembers: modules[paths[3]].groupMembers,
    schema: modules[paths[4]], PNG: require('pngjs').PNG,
    identity: { name: metadata.name, version: metadata.version, packageJson: identity(packageBytes), modules: hashes, dependencyVersions, packageFiles, packageFilesSha256: digest(JSON.stringify(packageFiles)), chromium: browserMetadata.browsers.find((browser) => browser.name === 'chromium') },
  };
}

async function imageAt(api, run, artifact, viewport) {
  assert(!isAbsolute(artifact.path) && contains(run.paths.runDir, resolve(run.paths.runDir, artifact.path)), 'Source artifact path must remain inside the run');
  const bytes = await readFile(join(run.paths.runDir, artifact.path));
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(digest(bytes), artifact.sha256);
  const image = api.PNG.sync.read(bytes, { checkCRC: true });
  assert.equal(image.width, viewport.width);
  assert.equal(image.height, viewport.height);
  return image;
}

const moverRectangle = (viewport) => ({ x: 0, y: 135, width: viewport.width, height: 40 });
const nativeRectangle = (viewport) => ({ x: 0, y: 205, width: viewport.width, height: 40 });
const pulseRectangle = (viewport) => ({ x: viewport.width - 110, y: 40, width: 90, height: 40 });
const pulseOn = (observation, rectangle) => observation.pixels > rectangle.width * rectangle.height / 2;

async function sourceMetrics(api, bundle, run, viewport) {
  const scenario = bundle.motion[0];
  const results = {};
  const artifacts = new Map();
  for (const side of sides) {
    const track = scenario.tracks[side];
    assert.equal(track.status, 'ok', `${side} capture must complete without a fault`);
    assert(track.clock.errorBoundMs <= 40);
    assert.equal(track.stats.persistedFrames, track.stats.receivedFrames);
    assert.equal(track.stats.acknowledgedFrames, track.stats.receivedFrames);
    const observations = [];
    const nativePositions = new Set();
    const pulses = [];
    let wasPulse = false;
    for (const frame of track.frames) {
      artifacts.set(frame.artifact.path, frame.artifact);
      const image = await imageAt(api, run, frame.artifact, viewport);
      checkMask(image, mask);
      const value = observe(image, moverRectangle(viewport), 'mover');
      observations.push({ x: value.x, runElapsedMs: frame.runElapsedMs, sourceMonotonicSeconds: frame.sourceMonotonicSeconds });
      const native = observe(image, nativeRectangle(viewport), 'native');
      if (native.x !== null) nativePositions.add(native.x);
      const on = pulseOn(observe(image, pulseRectangle(viewport), 'pulse'), pulseRectangle(viewport));
      if (on && !wasPulse) pulses.push(frame.runElapsedMs);
      wasPulse = on;
    }
    const movement = movingMetrics(observations, scenario.steps[1][side].dispatch.runElapsedMs);
    assert(movement.distinctPositions >= 60, `${side} needs 60 actual moving-object positions, observed ${movement.distinctPositions}`);
    assert(movement.maxMovingGapMs <= 200, `${side} known-moving source gap is ${movement.maxMovingGapMs} ms`);
    assert(nativePositions.size >= 10, `${side} native transition must have intermediate positions`);
    assert.equal(pulses.length, 3, `${side} must retain all three pulses`);
    results[side] = { ...movement, pulses, nativeDistinctPositions: nativePositions.size, clock: track.clock, stats: track.stats, gaps: track.gaps };
  }
  for (const step of bundle.scenarios[0].steps)
    for (const side of sides) {
      assert.equal(step[side].status, 'ok', `${side} ${step.id} checkpoint must succeed`);
      artifacts.set(step[side].image.path, step[side].image);
      checkMask(await imageAt(api, run, step[side].image, viewport), mask);
    }
  for (const side of sides) {
    const steps = bundle.scenarios[0].steps;
    const before = await imageAt(api, run, steps[1][side].image, viewport);
    const after = await imageAt(api, run, steps[2][side].image, viewport);
    const rectangle = { x: 40, y: 310, width: 100, height: 20 };
    const scroll = { beforeBluePixels: bluePixels(before, rectangle), afterBluePixels: bluePixels(after, rectangle) };
    assert(scroll.afterBluePixels - scroll.beforeBluePixels >= 1000, `${side} scroll must change the visible inner-container stripe`);
    results[side].scroll = scroll;
  }
  const files = (await readdir(run.paths.framesDir)).sort();
  assert.deepEqual(files.map((file) => 'frames/' + file), [...artifacts.keys()].sort(), 'Every persisted source image must be checked');
  const pulseErrorsMs = results.before.pulses.map((time, index) => Math.abs(time - results.after.pulses[index]));
  assert(Math.max(...pulseErrorsMs) <= 80, 'Mapped source pulses must align within 80 ms');
  return { tracks: results, pulseErrorsMs, checkedPersistedImages: artifacts.size };
}

async function decodeMetrics(api, bundle, timeline, media, run, viewport) {
  const directory = join(run.paths.privateDir, 'motion-check-decoded');
  await mkdir(directory, { mode: 0o700 });
  const capabilities = await api.checkMediaCapabilities(run);
  const child = await run.supervisor.spawn({
    argv: [capabilities.ffmpeg.executable, '-v', 'error', '-threads', '2', '-i', join(run.paths.runDir, media.video.path), '-threads', '2', '-fps_mode', 'passthrough', '-frames:v', String(timeline.totalFrames), join(directory, '%06d.png')],
    cwd: run.paths.runDir, purpose: 'probe', timeoutMs: 120000,
  });
  const exit = await child.exited;
  assert(exit.code === 0 && !exit.signal && !exit.spawnError, 'Bounded full-video decode must succeed');
  const files = (await readdir(directory)).sort();
  assert.equal(files.length, timeline.totalFrames, 'Every encoded frame must decode');
  const segment = timeline.segments.find((entry) => entry.kind === 'motion');
  assert(segment);
  const selections = new Map(timeline.selections.map((entry) => [entry.frame, entry]));
  const results = Object.fromEntries(sides.map((side) => [side, { observations: [], pulses: [], checkedMasks: 0, wasPulse: false }]));
  for (let frame = 0; frame < files.length; frame++) {
    const image = api.PNG.sync.read(await readFile(join(directory, files[frame])), { checkCRC: true });
    assert.equal(image.width, 1920); assert.equal(image.height, 686);
    if (frame < segment.startFrame || frame >= segment.startFrame + segment.durationFrames) continue;
    const runElapsedMs = segment.sourceStartMs + (frame - segment.startFrame) * 1000 / 30;
    for (const side of sides) {
      const result = results[side];
      const geometry = panelGeometry(viewport, side);
      const rectangle = mapRectangle(pulseRectangle(viewport), geometry, 2);
      const on = pulseOn(observe(image, rectangle, 'pulse'), rectangle);
      if (on && !result.wasPulse) result.pulses.push(frame * 1000 / 30);
      result.wasPulse = on;
      result.observations.push({ x: observe(image, mapRectangle(moverRectangle(viewport), geometry), 'mover').x, runElapsedMs });
      if (selections.get(frame)?.[side]) {
        checkMask(image, mapRectangle(mask, geometry, 4), true);
        result.checkedMasks++;
      }
    }
    await rm(join(directory, files[frame]));
  }
  const tracks = {};
  for (const side of sides) {
    const { observations, pulses, checkedMasks } = results[side];
    const movement = movingMetrics(observations, bundle.motion[0].steps[1][side].dispatch.runElapsedMs);
    assert(movement.distinctPositions >= 60, `${side} needs 60 decoded moving-object positions, observed ${movement.distinctPositions}`);
    assert.equal(pulses.length, 3, `${side} must retain three decoded pulses`);
    assert(checkedMasks > 0, 'Decoded masks must be checked');
    tracks[side] = { ...movement, pulses, checkedMasks, panelGeometry: panelGeometry(viewport, side) };
  }
  const pulseErrorsMs = tracks.before.pulses.map((time, index) => Math.abs(time - tracks.after.pulses[index]));
  assert(Math.max(...pulseErrorsMs) <= 80, 'Decoded pulses must align within 80 ms');
  await rm(directory, { recursive: true });
  return { decodedFrames: files.length, tracks, pulseErrorsMs, maskTolerancePerChannel: 24, maskInteriorInsetPixels: 4 };
}

export function captureTrackEvidence(bundle) {
  const numeric = (value, keys) => Object.fromEntries(keys.map((key) => [key, Number.isFinite(value?.[key]) ? value[key] : null]));
  const frameTimes = (frame) => frame ? numeric(frame, ['sequence', 'sourceMonotonicSeconds', 'runElapsedMs', 'receivedMs']) : null;
  return Object.fromEntries(sides.map((side) => {
    const track = bundle.motion?.[0]?.tracks?.[side];
    const frames = Array.isArray(track?.frames) ? track.frames : [];
    const samples = Array.isArray(track?.clock?.samples) ? track.clock.samples : [];
    return [side, {
      status: ['ok', 'failed'].includes(track?.status) ? track.status : null,
      failureCode: typeof track?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(track.error.code) ? track.error.code : null,
      failureAtMs: Number.isFinite(track?.failureAtMs) ? track.failureAtMs : null,
      clock: track?.clock ? {
        ...numeric(track.clock, ['rate', 'offsetMs', 'uncertaintyMs', 'maxDriftMs', 'errorBoundMs']),
        sampleCount: samples.length,
        samples: samples.slice(-128).map((sample) => numeric(sample, ['sourceSeconds', 'hostBeforeMs', 'hostAfterMs'])),
      } : null,
      stats: numeric(track?.stats, ['receivedFrames', 'persistedFrames', 'acknowledgedFrames', 'rejectedFrames', 'maxQueueDepth', 'sourceDroppedFrames', 'maxGapMs']),
      frameCount: frames.length,
      firstFrame: frameTimes(frames[0]),
      lastFrame: frameTimes(frames.at(-1)),
    }];
  }));
}

export async function saveValidatedArtifacts(api, media, runDirectory, caseDirectory, id) {
  const files = [];
  for (const name of ['compare.mp4', 'poster.png', 'capture.json', 'timeline.json']) {
    const bytes = await readFile(join(runDirectory, name));
    if (name === 'compare.mp4') assert.equal(digest(bytes), media.video.sha256);
    if (name === 'poster.png') {
      assert.equal(digest(bytes), media.poster.sha256);
      const image = api.PNG.sync.read(bytes, { checkCRC: true });
      assert.equal(image.width, 1920); assert.equal(image.height, 686);
    }
    files.push({ name, bytes });
  }
  const artifacts = {};
  for (const { name, bytes } of files) {
    await writeFile(join(caseDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
    artifacts[name] = { path: `${id}/${name}`, ...identity(bytes) };
  }
  return artifacts;
}

async function executeCase(api, original, viewport, repetition, outputDir, signal) {
  const id = `${viewport.width}x${viewport.height}-run-${repetition}`;
  const caseDirectory = join(outputDir, id);
  await mkdir(caseDirectory, { mode: 0o700 });
  const result = { id, viewport, repetition, status: 'failed', host: { parallelism: availableParallelism(), loadAverage: loadavg() }, visualReview: { status: 'pending', normalSpeed: true }, cleanup: null };
  const servers = [];
  const owned = [];
  let run;
  try {
    const pair = {};
    const html = fixtureHtml(original, viewport);
    result.fixtureSha256 = digest(html);
    for (const side of sides) {
      const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
      servers.push(server);
      await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
      const port = server.address().port;
      pair[side] = { side, origin: `http://127.0.0.1:${port}`, port, sourceLabel: `${side} synthetic`, source: { requested: side, commit: 'a'.repeat(40), kind: 'commit', materializedHash: digest(html) }, storageState: null, exited: new Promise(() => {}) };
    }
    const processing = [];
    result.processing = processing;
    result.timestampRejections = [];
    result.shutdownFailures = [];
    run = await api.createRunContext({ repoRoot: caseDirectory, timeoutMs: 240000, signal, diagnostics: { event(event) { try { const item = JSON.parse(event); if (item.kind === 'capture-processing') processing.push(item); if (item.kind === 'capture-timestamp-rejection') result.timestampRejections.push(item); if (item.kind === 'capture-shutdown-failure') result.shutdownFailures.push(item); } catch {} } } });
    for (const method of ['spawn', 'adopt']) {
      const originalMethod = run.supervisor[method].bind(run.supervisor);
      run.supervisor[method] = async (...args) => { const child = await originalMethod(...args); owned.push(child); return child; };
    }
    const scenario = api.schema.ScenarioSchema.parse({ schemaVersion: 2, id: 'controlled-motion', title: 'Controlled three second motion', steps: [
      { id: 'open', op: 'goto', path: '/', observeMs: 100 },
      { id: 'move', op: 'click', target: { role: 'button', name: 'Start motion' }, observeMs: 3000 },
      { id: 'scroll', op: 'scrollBy', target: { testId: 'inner-scroll' }, y: 850, observeMs: 150 },
      { id: 'checkpoint', op: 'screenshot', observeMs: 0 },
    ] });
    const settings = api.schema.CaptureSettingsSchema.parse({ mode: 'motion', viewport, maskRects: [mask] });
    const bundle = await api.capture(pair, [scenario], settings, run);
    result.captureOutcome = bundle.scenarios[0].outcome;
    result.captureTracks = captureTrackEvidence(bundle);
    assert.equal(bundle.scenarios[0].outcome, 'ok');
    result.dispatchSkewMs = Math.abs(bundle.motion[0].steps[1].before.dispatch.runElapsedMs - bundle.motion[0].steps[1].after.dispatch.runElapsedMs);
    result.stepTiming = bundle.motion[0].steps;
    result.source = await sourceMetrics(api, bundle, run, viewport);
    const timeline = await api.render(bundle, { coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true }, provenance: { before: { valid: true, actualHash: null, errors: [] }, after: { valid: true, actualHash: null, errors: [] } } }, run);
    api.validateTimelineCapture(timeline, bundle);
    const media = await api.encode(timeline, run);
    result.decoded = await decodeMetrics(api, bundle, timeline, media, run, viewport);
    result.media = media;
    result.totalFrames = timeline.totalFrames;
    result.artifacts = await saveValidatedArtifacts(api, media, run.paths.runDir, caseDirectory, id);
    result.status = 'numeric-passed';
  } catch (error) {
    result.failure = { code: error.detail?.code ?? error.code ?? 'MOTION_CHECK_FAILED', message: error instanceof assert.AssertionError ? error.message.replaceAll(caseDirectory, '[output]') : 'The installed motion pipeline did not complete. Inspect its private run diagnostics.' };
  } finally {
    const errors = [];
    if (run) {
      try {
        const cleanup = await api.cleanupRun(run);
        assert.equal(cleanup.status, 'ok');
        for (const child of owned) assert.equal((await api.groupMembers(child.groupId)).length, 0, 'Owned child group must be absent after cleanup');
        await assert.rejects(lstat(join(caseDirectory, '.show-what-changed/run.lock')), { code: 'ENOENT' });
        await assert.rejects(lstat(run.paths.tempDir), { code: 'ENOENT' });
      } catch { errors.push('Owned runtime cleanup or absence checks failed'); }
    }
    for (const server of servers) {
      try {
        server.closeAllConnections();
        await new Promise((done, reject) => { server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()); });
        assert(!server.listening);
      } catch { errors.push('Owned fixture server cleanup failed'); }
    }
    result.cleanup = { status: errors.length ? 'failed' : 'ok', errors, ownedChildGroupsChecked: owned.length, serversClosed: servers.filter((server) => !server.listening).length };
    if (errors.length) result.status = 'failed';
    await writeFile(join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return result;
}

export async function verifyInstalledMotion(options) {
  assert(/^v24\./.test(process.version), 'Installed motion verification requires Node 24');
  const installedRoot = await existingDirectory(options.installedRoot);
  const outputDir = await newOutput(options.outputDir, installedRoot);
  const report = { schemaVersion: 1, specRevision: '0.3', scope: 'installed-synthetic-motion-numeric-check', status: 'failed', platform: process.platform, architecture: process.arch, node: process.version, startedAt: new Date().toISOString(), repetitions: options.repetitions, requiredRepetitions: 3, requiredViewports: viewports, visualReview: { status: 'pending', instruction: 'Review each compare.mp4 at normal speed and record stalls, invented motion, masking, and perceptual quality separately.' }, releaseAcceptance: 'not-evaluated', cases: [] };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Verifier interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const api = await loadInstalled(installedRoot);
    report.installedPackage = api.identity;
    const original = await readFile(new URL('../fixtures/motion/index.html', import.meta.url), 'utf8');
    report.originalFixture = { path: 'fixtures/motion/index.html', sha256: digest(original) };
    for (const viewport of viewports) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        if (controller.signal.aborted) throw new Error('Verifier interrupted');
        process.stderr.write(`Motion check ${viewport.width}x${viewport.height} repetition ${repetition}\n`);
        const result = await executeCase(api, original, viewport, repetition, outputDir, controller.signal);
        result.savedResult = { path: `${result.id}/result.json`, ...identity(await readFile(join(outputDir, result.id, 'result.json'))) };
        report.cases.push(result);
        if (result.status !== 'numeric-passed') throw new Error('Motion case failed');
      }
    }
    report.status = 'numeric-passed';
  } catch {
    report.failure = { code: controller.signal.aborted ? 'INTERRUPTED' : 'MOTION_CHECK_FAILED', message: 'At least one installed motion check did not complete successfully. Numeric success never substitutes for visual review or candidate acceptance.' };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.completedAt = new Date().toISOString();
    report.completeRepetitionMatrix = report.status === 'numeric-passed' && options.repetitions === 3 && report.cases.length === 6;
    await writeFile(join(outputDir, 'motion-check.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await verifyInstalledMotion(options);
    process.stdout.write(JSON.stringify({ status: report.status, completeRepetitionMatrix: report.completeRepetitionMatrix, visualReview: report.visualReview.status, report: join(options.outputDir, 'motion-check.json') }) + '\n');
    if (report.status !== 'numeric-passed') process.exitCode = 1;
  } catch {
    process.stderr.write('Usage: node scripts/revision-0.3-motion-check.mjs --installed-root /absolute/installed/show-what-changed --output-dir /absolute/new/output [--repetitions 1|2|3]\n');
    process.exitCode = 2;
  }
}
