/** Regression: one controller-local node plus agents is a multi-node topology. */
import assert from 'node:assert/strict';
import { expandConfig } from '../src/lab/modes.mjs';
import { up } from '../src/lab/orchestrator.mjs';

const sharded = expandConfig({ mode: 'sharded', nodes: 1, remoteNodes: 2 });
assert.equal(sharded.nodes, 1, 'nodes remains the number of local processes');
assert.equal(sharded.lb, true);
assert.equal(sharded.affinity, 'room');
assert.equal(sharded.adapter, false);

const shared = expandConfig({ mode: 'shared', nodes: 1, remoteNodes: 2 });
assert.equal(shared.lb, true);
assert.equal(shared.adapter, true);
assert.equal(shared.store, 'shared');
assert.equal(shared.requires.redis, true);

for (const mode of ['single', 'sharded', 'shared']) {
  const one = expandConfig({ mode, nodes: 1 });
  assert.equal(one.lb, false, 'a sole node still needs no load balancer');
  assert.equal(one.adapter, false);
  assert.equal(one.store, 'local');
}

// Both guards run before creating processes or contacting the documentation IP.
await assert.rejects(up({ mode: 'single', agents: ['http://192.0.2.1:9100'], withWeb: false }), /single.*agent/);
await assert.rejects(up({ mode: 'shared', overrides: { nodes: 1 }, agents: ['http://192.0.2.1:9100'], withWeb: false }), /SQLite.*跨主机/);
console.log('PASS one-local-node agent topology, standalone fallback and unsupported-mode guards');
