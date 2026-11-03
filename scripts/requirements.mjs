import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const spec = await readFile(new URL('../spec.md', import.meta.url), 'utf8');
const previousPath = new URL('../evidence/requirements.json', import.meta.url);
let previous = [];
try { previous = JSON.parse(await readFile(previousPath, 'utf8')).requirements; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const existing = new Map(previous.map((item) => [item.id, item]));
const ownerBySection = { 1: 'N9', 2: 'N0', 3: 'N0', 4: 'N4', 5: 'N1', 6: 'N4', 7: 'N2', 8: 'N2', 9: 'N3', 10: 'N5', 11: 'N1', 12: 'N9' };
let section = '', inCode = false;
const requirements = [];
for (const [index, line] of spec.split('\n').entries()) {
  if (line.startsWith('```')) { inCode = !inCode; continue; }
  const heading = line.match(/^#{2,3} (\d+(?:\.\d+)?)\.?(?:\s|$)/);
  if (heading) section = heading[1];
  const major = Number(section.split('.')[0]);
  if (!section || major > 12 || inCode || !line.trim() || line.startsWith('#') || /^\|[\s|:-]+\|$/.test(line)) continue;
  const acceptance = line.match(/^\| (T\d\d) \|/);
  const id = acceptance ? acceptance[1] : `S${section}-${createHash('sha256').update(line).digest('hex').slice(0, 10)}`;
  const old = existing.get(id);
  requirements.push({ id, specLine: index + 1, section, requirement: line, owner: ownerBySection[major], state: old?.state ?? 'pending', code: old?.code ?? [], tests: old?.tests ?? [], evidence: old?.evidence ?? [], note: old?.note ?? '' });
}
await writeFile(previousPath, JSON.stringify({ schemaVersion: 1, specSha256: createHash('sha256').update(spec).digest('hex'), requirements }, null, 2) + '\n');
const rows = requirements.map((item) => `| ${item.id} | ${item.section} | ${item.owner} | ${item.state} | [contract](../spec.md#L${item.specLine}) | ${item.evidence.join(', ')} |`);
await writeFile(new URL('../evidence/requirements.md', import.meta.url), '# Requirement evidence matrix\n\nThe JSON matrix retains each requirement text with code, tests, and evidence fields. Pending means no final release proof has been accepted. N0 baseline checks do not complete whole acceptance IDs.\n\nRegenerate with `node scripts/requirements.mjs`. Existing evidence entries are preserved by content identity.\n\n| ID | Spec section | Owner | State | Source | Evidence |\n|---|---|---|---|---|---|\n' + rows.join('\n') + '\n');
process.stdout.write(`${requirements.length} contract rows, including ${requirements.filter((item) => /^T\d\d$/.test(item.id)).length} acceptance IDs\n`);
