import { isMainThread } from 'node:worker_threads';
import { registerHooks } from 'node:module';
export function sourceTarget(specifier: string, parentURL: string | undefined, root: string): string | null {
  if (!parentURL?.startsWith(root) || !specifier.startsWith('.') || !specifier.endsWith('.js')) return null;
  const target = new URL(specifier, parentURL);
  return target.href.startsWith(root) ? `${target.href.slice(0, -3)}.ts` : null;
}
const root = new URL('../', import.meta.url).href;
if (!isMainThread)
  registerHooks({
    resolve(specifier, context, next) {
      return next(sourceTarget(specifier, context.parentURL, root) ?? specifier, context);
    },
  });
