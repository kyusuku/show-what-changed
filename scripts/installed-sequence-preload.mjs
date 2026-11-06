import { appendFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cpus, freemem, loadavg } from 'node:os';

const command = process.argv[2];
const directory = process.env.SWC_OPERATION_TRACE_DIR;
const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (directory && ['compare', 'compose'].includes(command) && entry.endsWith('/show-what-changed/dist/cli/index.js')) {
  const output = join(directory, `${process.pid}.ndjson`);
  const started = performance.now();
  let eventCount = 0;
  const emit = (value) => {
    if (eventCount++ >= 12000) return;
    appendFileSync(output, `${JSON.stringify({ elapsedMs: performance.now() - started, ...value })}\n`, { mode: 0o600 });
  };
  emit({ event: 'trace-start', command, timeOrigin: performance.timeOrigin });
  let sampledAt = performance.now();
  let cpu = process.cpuUsage();
  const sample = () => {
    const now = performance.now();
    const current = process.cpuUsage();
    const system = cpus();
    emit({ event: 'resources', intervalMs: now - sampledAt, processUserUs: current.user - cpu.user, processSystemUs: current.system - cpu.system, rssBytes: process.memoryUsage().rss, freeMemoryBytes: freemem(), loadAverage: loadavg(), logicalCpus: system.length, systemCpuTimes: system.reduce((totals, item) => Object.fromEntries(Object.keys(totals).map((key) => [key, totals[key] + item.times[key]])), { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }) });
    cpu = current;
    sampledAt = now;
  };
  sample();
  const sampler = setInterval(sample, 1000);
  sampler.unref();
  process.once('exit', (code) => emit({ event: 'trace-exit', exitCode: code }));
  const { chromium } = createRequire(entry)('playwright');
  let browserIndex = 0;
  let operationIndex = 0;
  const connect = chromium.connect.bind(chromium);
  chromium.connect = async (...args) => {
    const browser = await connect(...args);
    const currentBrowser = ++browserIndex;
    let contextIndex = 0;
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...contextArgs) => {
      const context = await newContext(...contextArgs);
      const currentContext = ++contextIndex;
      let pageIndex = 0;
      const newPage = context.newPage.bind(context);
      context.newPage = async (...pageArgs) => {
        const page = await newPage(...pageArgs);
        const identity = { browserIndex: currentBrowser, contextIndex: currentContext, pageIndex: ++pageIndex };
        for (const method of ['goto', 'evaluate', 'waitForTimeout', 'screenshot', 'setContent']) {
          const original = page[method].bind(page);
          page[method] = async (...operationArgs) => {
            let operation = method;
            if (method === 'evaluate' && typeof operationArgs[0] === 'function') {
              const source = operationArgs[0].toString();
              if (source.includes('document.fonts.load')) operation = 'evaluate-template';
              else if (source.includes('document.fonts.ready')) operation = 'evaluate-settle';
              else if (source.includes('values.every')) operation = 'evaluate-mask-selectors';
            }
            const currentOperation = ++operationIndex;
            const begin = performance.now();
            emit({ event: 'operation-start', ...identity, operationIndex: currentOperation, operation });
            try {
              const result = await original(...operationArgs);
              emit({ event: 'operation-end', ...identity, operationIndex: currentOperation, operation, durationMs: performance.now() - begin, outcome: 'ok' });
              return result;
            } catch (error) {
              emit({ event: 'operation-end', ...identity, operationIndex: currentOperation, operation, durationMs: performance.now() - begin, outcome: 'error' });
              throw error;
            }
          };
        }
        emit({ event: 'page-instrumented', ...identity });
        return page;
      };
      return context;
    };
    return browser;
  };
}
