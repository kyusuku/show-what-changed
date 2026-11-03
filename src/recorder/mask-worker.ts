import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { ViewportInputSchema, MaskRectSchema } from '../schema/index.js';
import { SanitizerErrorCode } from './masker.js';
import { CaptureFault, sanitizeFrame } from './images.js';
const settings = z
  .strictObject({ viewport: ViewportInputSchema, maskRects: z.array(MaskRectSchema).max(20) })
  .parse(workerData);
const Message = z.strictObject({ id: z.number().int().nonnegative(), bytes: z.instanceof(Uint8Array) });
const port = parentPort;
if (!port) throw new Error('Mask worker requires an owned parent');
port.on('message', (value: unknown) => {
  const message = Message.safeParse(value);
  if (!message.success) {
    port.postMessage({ kind: 'fault', code: 'CAPTURE_WORKER_PROTOCOL' });
    return;
  }
  try {
    const bytes = sanitizeFrame(
      Buffer.from(message.data.bytes.buffer, message.data.bytes.byteOffset, message.data.bytes.byteLength),
      settings.viewport,
      settings.maskRects,
    );
    const safe = Uint8Array.from(bytes);
    port.postMessage({ kind: 'ok', id: message.data.id, bytes: safe }, [safe.buffer]);
  } catch (cause) {
    port.postMessage({
      kind: 'error',
      id: message.data.id,
      code:
        cause instanceof CaptureFault && SanitizerErrorCode.safeParse(cause.code).success
          ? cause.code
          : 'CAPTURE_PNG_INVALID',
    });
  }
});

port.postMessage({ kind: 'ready' });
