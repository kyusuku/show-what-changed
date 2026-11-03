import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { bluePixels, checkMask, fixtureHtml, mapRectangle, movingMetrics, observe, panelGeometry, parseArguments, viewports } from '../../scripts/revision-0.3-motion-check.mjs';

test('the verifier requires explicit absolute inputs and bounded, unique options', () => {
  expect(parseArguments(['--installed-root', '/installed', '--output-dir', '/result'])).toEqual({ installedRoot: '/installed', outputDir: '/result', repetitions: 3 });
  for (const argv of [[], ['--installed-root', 'relative', '--output-dir', '/result'], ['--installed-root', '/installed'], ['--installed-root', '/installed', '--output-dir', '/result', '--repetitions', '4'], ['--installed-root', '/installed', '--output-dir', '/result', '--output-dir', '/other'], ['--installed-root', '/installed', '--output-dir', '/result', '--unknown', 'value']])
    expect(() => parseArguments(argv)).toThrow();
});

test('source motion counts object positions in the actual three second window and includes boundary gaps', () => {
  const still = Array.from({ length: 91 }, (_, index) => ({ runElapsedMs: index * 1000 / 30, x: 50 }));
  expect(movingMetrics(still, 0).distinctPositions).toBe(1);
  const positions = still.map((entry, index) => ({ ...entry, x: index + 50 }));
  expect(movingMetrics(positions, 0).distinctPositions).toBe(91);
  expect(movingMetrics(positions, 0).maxMovingGapMs).toBeLessThan(34);
  expect(movingMetrics(positions.filter((entry) => entry.runElapsedMs >= 500), 0).maxMovingGapMs).toBe(500);
  expect(movingMetrics([...positions, { runElapsedMs: 4000, x: 999 }], 0).distinctPositions).toBe(91);
});

test('both required viewports map masks into actual scaled and letterboxed panels', () => {
  expect(viewports).toEqual([{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  for (const viewport of viewports) {
    const before = panelGeometry(viewport, 'before');
    const after = panelGeometry(viewport, 'after');
    expect(before.width).toBeLessThanOrEqual(958);
    expect(before.height).toBeLessThanOrEqual(598);
    expect(after.x - before.x).toBe(962);
    const rectangle = mapRectangle({ x: 0, y: 0, width: 140, height: 100 }, before, 4);
    expect(rectangle.x).toBeGreaterThan(before.x);
    expect(rectangle.y).toBeGreaterThan(before.y);
    expect(rectangle.x + rectangle.width).toBeLessThan(before.x + 140 * before.scaleX);
    expect(rectangle.y + rectangle.height).toBeLessThan(before.y + 100 * before.scaleY);
  }
  expect(panelGeometry(viewports[1], 'before').x).toBeGreaterThan(300);
});

test('every source mask pixel must be exact and opaque while decoded interiors allow bounded codec changes', () => {
  const image = { width: 3, height: 2, data: Buffer.alloc(3 * 2 * 4) };
  for (let p = 0; p < image.data.length; p += 4) image.data.set([16, 16, 16, 255], p);
  const rectangle = { x: 0, y: 0, width: 3, height: 2 };
  expect(() => checkMask(image, rectangle)).not.toThrow();
  image.data[image.data.length - 2] = 17;
  expect(() => checkMask(image, rectangle)).toThrow();
  expect(() => checkMask(image, rectangle, true)).not.toThrow();
  image.data[0] = 41;
  expect(() => checkMask(image, rectangle, true)).toThrow();
  image.data[0] = 16;
  image.data[3] = 254;
  expect(() => checkMask(image, rectangle, true)).toThrow();
});

test('image observations ignore unrelated color outside the measured object region', () => {
  const image = { width: 5, height: 3, data: Buffer.alloc(5 * 3 * 4, 255) };
  image.data.set([0, 237, 0, 255], (1 * 5 + 2) * 4);
  image.data.set([0, 237, 0, 255], (0 * 5 + 4) * 4);
  image.data.set([109, 174, 227, 255], (2 * 5 + 1) * 4);
  expect(observe(image, { x: 0, y: 1, width: 5, height: 1 }, 'mover')).toEqual({ x: 2, pixels: 1 });
  expect(bluePixels(image, { x: 0, y: 2, width: 5, height: 1 })).toBe(1);
});

test('the original controlled fixture stays recognizable and its motion remains visible at the narrow viewport', async () => {
  const original = await readFile(new URL('../../fixtures/motion/index.html', import.meta.url), 'utf8');
  const adapted = fixtureHtml(original, viewports[1]);
  expect(adapted).toContain('translateX(320px)');
  expect(adapted).toContain('.pulse{left:280px}');
  expect(adapted).toContain('transition:transform 1.2s ease-in-out');
  expect(adapted).toContain('for(const delay of [100,1100,2100])');
  expect(adapted).toContain('SYNTHETIC PRIVATE STRING');
});
