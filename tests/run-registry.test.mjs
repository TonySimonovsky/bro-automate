/**
 * RunRegistry unit tests (badge / PRD FR-X1 — active vs total count).
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { RunRegistry } from '../extension/lib/run-registry.js';

test('RunRegistry activeCount excludes terminal runs', () => {
  const r = new RunRegistry();
  assert.equal(r.activeCount(), 0);
  const id = r.create({ scenarioId: 's', requestId: 'q' });
  assert.equal(r.activeCount(), 1);
  assert.equal(r.count(), 1);
  r.setStatus(id, 'running');
  assert.equal(r.activeCount(), 1);
  r.markDone(id, { ok: true });
  assert.equal(r.count(), 1);
  assert.equal(r.activeCount(), 0);
});

test('RunRegistry activeCount excludes error and cancelled', () => {
  const r = new RunRegistry();
  const a = r.create({ scenarioId: 's', requestId: 'r1' });
  r.setStatus(a, 'running');
  r.markError(a, 'x', 'msg');
  assert.equal(r.activeCount(), 0);
  const b = r.create({ scenarioId: 's', requestId: 'r2' });
  r.setStatus(b, 'running');
  r.markCancelled(b);
  assert.equal(r.activeCount(), 0);
});
