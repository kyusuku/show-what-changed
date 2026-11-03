import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const generated = JSON.parse(readFileSync(process.argv[2] ?? new URL('../evidence/n0-fixture.json', import.meta.url), 'utf8'));
const outputDir = resolve(process.argv[3] ?? join(tmpdir(), 'swc-fixture-smoke'));
mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const proof = { node: process.version, browser: browser.version(), urls: { before: process.argv[4] ?? 'http://127.0.0.1:4389', after: process.argv[5] ?? 'http://127.0.0.1:4388' } };
try {
 const contexts = await Promise.all([0,1].map(() => browser.newContext({ viewport: {width:1280,height:800}, deviceScaleFactor:1, locale:'en-US', timezoneId:'UTC', reducedMotion:'reduce', serviceWorkers:'block' })));
 const [before, after] = await Promise.all(contexts.map(c=>c.newPage()));
 for (const page of [before,after]) { await page.clock.setFixedTime(new Date('2026-01-15T10:00:00.000Z')); page.on('pageerror', e=>errors.push(e.message)); }
 await Promise.all([before.goto(`${proof.urls.before}/pricing`),after.goto(`${proof.urls.after}/pricing`)]);
 await before.getByRole('heading', {name:'Pricing',exact:true}).waitFor();
 await after.getByRole('heading', {name:'Pricing',exact:true}).waitFor();
 assert.equal(await before.getByRole('switch',{name:'Yearly',exact:true}).count(),0);
 await assert.rejects(before.getByRole('switch',{name:'Yearly',exact:true}).click({timeout:200}), /Timeout/);
 await after.getByRole('switch',{name:'Yearly',exact:true}).click();
 await after.getByText('Save 20%',{exact:true}).waitFor();
 assert.equal(await after.getByRole('button',{name:'Legacy details',exact:true}).count(),0);
 assert.equal(await before.getByRole('button',{name:'Legacy details',exact:true}).count(),1);
 for (const page of [before,after]) {
  await page.getByRole('button',{name:'Get Pro',exact:true}).hover();
  await page.getByTestId('hover-state').waitFor({state:'visible'});
  await page.screenshot({path:page===before?join(outputDir, 'before-masked.png'):join(outputDir, 'after-masked.png'),mask:[page.getByTestId('synthetic-secret')],maskColor:'#ff00ff',animations:'disabled',caret:'hide'});
  assert.equal(await page.getByRole('button',{name:'Get Pro',exact:true}).evaluate(el=>el.matches(':hover')),true);
 }
 proof.pricing={expectedMissingBefore:true,yearlyAfter:true,save20After:true,legacyMissingAfter:true,hoverRetained:true, heights: await Promise.all([before,after].map(p=>p.evaluate(()=>document.documentElement.scrollHeight)))};
 assert.notEqual(...proof.pricing.heights);
 const box = await after.getByTestId('synthetic-secret').boundingBox();
 const png = PNG.sync.read(readFileSync(join(outputDir, 'after-masked.png')));
 for(let y=Math.ceil(box.y);y<Math.floor(box.y+box.height);y++) for(let x=Math.ceil(box.x);x<Math.floor(box.x+box.width);x++) {
  const i=(y*png.width+x)*4; assert.deepEqual([...png.data.subarray(i,i+4)],[255,0,255,255]);
 }
 proof.mask={selector:'[data-testid=synthetic-secret]',allRegionPixelsMasked:true,width:png.width,height:png.height};
 await after.goto(`${proof.urls.after}/readiness`);
 await after.getByText('Data ready',{exact:true}).waitFor();
 await after.getByText('2026-01-15T10:00:00.000Z',{exact:true}).waitFor();
 await after.getByText('Animation frames live',{exact:true}).waitFor();
 await after.getByLabel('Search plans',{exact:true}).fill('synthetic');
 await after.getByText('Results for synthetic',{exact:true}).waitFor();
 const fragment = await after.goto(`${proof.urls.after}/readiness#details`);
 assert.equal(fragment,null);
 proof.readiness={delayedData:true,fixedDate:true,liveAnimationFrames:true,debounce:true,sameDocumentFragment:true};
 const response=await after.goto(`${proof.urls.after}/failure`);
 assert.equal(response.status(),503);
 proof.navigationFailureStatus=response.status();
 await after.goto(`${proof.urls.after}/controls`);
 assert.equal(await after.getByRole('button',{name:'Duplicate',exact:true}).count(),2);
 assert.equal(await after.getByRole('button',{name:'Disabled control',exact:true}).isDisabled(),true);
 assert.equal(await after.getByText('Hidden control',{exact:true}).isVisible(),false);
 proof.failureControls={ambiguous:2,disabled:true,hidden:true};
 assert.deepEqual(errors,[]);
 proof.pageErrors=errors;
 proof.generatedSourceUnchanged = [generated.first.repoRoot,generated.second.repoRoot].every(repoRoot=>execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8'})==='');
 assert.equal(proof.generatedSourceUnchanged,true);
 writeFileSync(join(outputDir, 'browser-proof.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof,null,2));
} finally { await browser.close(); }
