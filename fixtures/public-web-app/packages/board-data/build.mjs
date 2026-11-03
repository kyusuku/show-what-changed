import { cp, mkdir } from 'node:fs/promises';

const source = new URL('./src/', import.meta.url);
const destination = new URL('./dist/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
process.stdout.write('Built @workshop/board-data.\n');
