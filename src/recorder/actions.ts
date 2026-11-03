import type { Locator as BrowserLocator, Page } from 'playwright';
import type { Locator, Step } from '../schema/index.js';
import { CaptureFault } from './images.js';

export function exactLocator(page: Page, target: Locator): BrowserLocator {
  if ('role' in target) {
    const options = target.name === undefined ? {} : { name: target.name, exact: true };
    return page.getByRole(target.role, options).or(page.getByRole(target.role, { ...options, includeHidden: true }));
  }
  if ('label' in target) return page.getByLabel(target.label, { exact: true });
  if ('text' in target) return page.getByText(target.text, { exact: true });
  if ('testId' in target) return page.getByTestId(target.testId);
  return page.locator(`css=${target.css}`);
}

function remaining(deadline: number): number {
  const value = deadline - performance.now();
  if (value <= 0) throw new CaptureFault('STEP_TIMEOUT');
  return value;
}

async function findOne(page: Page, target: Locator, deadline: number): Promise<BrowserLocator | null> {
  if ('css' in target) {
    const valid = await page.evaluate((selector) => {
      try {
        document.querySelector(selector);
        return true;
      } catch {
        return false;
      }
    }, target.css);
    if (!valid) throw new CaptureFault('INVALID_LOCATOR_SELECTOR');
  }
  const locator = exactLocator(page, target);
  while (performance.now() < deadline) {
    const count = await locator.count();
    if (count > 1) throw new CaptureFault('LOCATOR_AMBIGUOUS');
    if (count === 1) return locator;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
  }
  return null;
}

export async function performAction(options: {
  page: Page;
  step: Step;
  origin: string;
  deadline: number;
  successfulDocument: string | null;
}): Promise<{ kind: 'done'; successfulDocument: string | null } | { kind: 'missing' }> {
  const { page, step, origin, deadline, successfulDocument } = options;
  if ('target' in step && step.target !== undefined) {
    const presenceDeadline = deadline - Math.min(50, Math.max(1, (deadline - performance.now()) / 10));
    const locator = await findOne(page, step.target, presenceDeadline);
    if (!locator) return { kind: 'missing' };
    const timeout = remaining(deadline);
    switch (step.op) {
      case 'click':
        await locator.click({ timeout });
        break;
      case 'fill':
        await locator.fill(step.value, { timeout });
        break;
      case 'hover':
        await locator.hover({ timeout });
        break;
      case 'expectVisible':
        await locator.waitFor({ state: 'visible', timeout });
        break;
      case 'scrollBy':
        await smoothScroll(page, locator, step.y, deadline);
        break;
    }
    return { kind: 'done', successfulDocument };
  }
  switch (step.op) {
    case 'goto': {
      const url = new URL(step.path, origin);
      if (url.origin !== origin) throw new CaptureFault('NAVIGATION_ORIGIN');
      const prior = page.url();
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: remaining(deadline) });
      if (new URL(page.url()).origin !== origin) throw new CaptureFault('NAVIGATION_ORIGIN');
      if (response === null) {
        const previous = new URL(prior);
        const current = new URL(page.url());
        const fragmentOnly =
          successfulDocument !== null &&
          url.hash !== previous.hash &&
          url.origin === previous.origin &&
          url.pathname === previous.pathname &&
          url.search === previous.search &&
          current.href === url.href &&
          successfulDocument === `${previous.origin}${previous.pathname}${previous.search}`;
        if (!fragmentOnly) throw new CaptureFault('NAVIGATION_NO_RESPONSE');
      } else if (response.status() < 200 || response.status() >= 400) throw new CaptureFault('NAVIGATION_STATUS');
      return {
        kind: 'done',
        successfulDocument: `${url.origin}${new URL(page.url()).pathname}${new URL(page.url()).search}`,
      };
    }
    case 'scrollBy':
      await smoothScroll(page, null, step.y, deadline);
      break;
    case 'screenshot':
      break;
  }
  return { kind: 'done', successfulDocument };
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const overlays = page.locator(
    '[data-nextjs-dialog-overlay], [data-nextjs-dialog-error], [data-nextjs-error-overlay], #nextjs__container_errors_label',
  );
  for (let index = 0; index < (await overlays.count()); index++) {
    if (await overlays.nth(index).isVisible()) throw new CaptureFault('APPLICATION_ERROR_OVERLAY');
  }
}

async function smoothScroll(page: Page, locator: BrowserLocator | null, y: number, deadline: number): Promise<void> {
  const desired = locator
    ? await locator.evaluate((element, delta) => {
        const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + delta));
        element.scrollBy({ top: delta, behavior: 'smooth' });
        return target;
      }, y)
    : await page.evaluate((delta) => {
        const element = document.scrollingElement;
        if (!element) throw new Error('Missing scrolling element');
        const target = Math.max(0, Math.min(element.scrollHeight - window.innerHeight, window.scrollY + delta));
        window.scrollBy({ top: delta, behavior: 'smooth' });
        return target;
      }, y);
  let stable = 0;
  while (performance.now() < deadline) {
    const position = locator
      ? await locator.evaluate((element) => element.scrollTop)
      : await page.evaluate(() => window.scrollY);
    stable = Math.abs(position - desired) <= 1 ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(Math.min(20, remaining(deadline)));
  }
  throw new CaptureFault('SCROLL_TIMEOUT');
}
