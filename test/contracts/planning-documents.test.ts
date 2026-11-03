import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type NodeCard = { id: string; dependsOn: string[]; startHour: number; endHour: number; gateIds: string[] };

describe('active implementation contract', () => {
  it('binds the current public inputs and the same complete gate set', async () => {
    const [spec, goal, graphText, ledgerText] = await Promise.all(['spec.md', 'docs/implementation-goal.md', 'docs/implementation-graph.json', 'evidence/revision-0.3-status.json'].map((path) => readFile(path, 'utf8')));
    const graph = JSON.parse(graphText!);
    const ledger = JSON.parse(ledgerText!);
    const requirements = new Map([...spec!.matchAll(/^\| (G\d\d) \| (.*?) \|$/gm)].map((match) => [match[1], match[2]]));
    expect(requirements.size).toBe(24);
    expect(ledger.gates.map((gate: { id: string }) => gate.id).sort()).toEqual([...requirements.keys()].sort());
    for (const gate of ledger.gates) {
      expect(gate.requirement, gate.id).toBe(requirements.get(gate.id));
      const nodes = graph.nodes.filter((node: NodeCard) => node.gateIds.includes(gate.id)).map((node: NodeCard) => node.id).sort();
      expect([...gate.nodeIds].sort(), gate.id).toEqual(nodes);
    }
    for (const path of ['spec.md', 'docs/implementation-graph.json', 'docs/web-app-acceptance.md']) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      expect(goal).toContain(`${path} SHA-256 is ${hash}.`);
      expect(ledger.publicContractInputs[path]).toBe(hash);
    }
  });
  it('keeps an acyclic dependency graph with explicit owners and bounded checkpoints', async () => {
    const graph = JSON.parse(await readFile('docs/implementation-graph.json', 'utf8'));
    const nodes = new Map<string, NodeCard>(graph.nodes.map((node: NodeCard) => [node.id, node]));
    expect(nodes.size).toBe(17);
    expect(graph.maxConcurrentOwners).toBe(4);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      expect(visiting.has(id), `cycle at ${id}`).toBe(false);
      if (visited.has(id)) return;
      const node = nodes.get(id);
      expect(node, id).toBeDefined();
      visiting.add(id);
      for (const dependency of node!.dependsOn) {
        expect(nodes.get(dependency)?.endHour, `${dependency} before ${id}`).toBeLessThanOrEqual(node!.startHour);
        visit(dependency);
      }
      visiting.delete(id); visited.add(id);
    };
    for (const id of nodes.keys()) visit(id);
    expect(visited.size).toBe(17);
    expect(graph.currentGoal.excludes).toContain('publication');
  });
});
