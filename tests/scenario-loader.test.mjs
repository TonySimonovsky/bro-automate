import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAllWithIds } from '../extension/lib/scenario-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const schemaPath = path.join(repoRoot, 'schema/scenario.schema.json');
const fixturesDir = path.join(__dirname, 'fixtures/scenarios');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function fetchFixture(id) {
  const p = path.join(fixturesDir, `${id}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function fetchScenarioJson(id) {
  return fetchFixture(id);
}

test('loading 01-valid-minimal succeeds and registers it', async () => {
  const { scenarios, skipped } = await loadAllWithIds(['01-valid-minimal'], {
    fetchScenarioJson,
    schema,
  });
  assert.equal(skipped.length, 0);
  assert.equal(scenarios.size, 1);
  assert.ok(scenarios.has('fixture-minimal'));
});

test('loading 04-invalid-bad-schemaversion soft-skips with reason unsupportedSchemaVersion and does NOT throw', async () => {
  const { scenarios, skipped } = await loadAllWithIds(['04-invalid-bad-schemaversion'], {
    fetchScenarioJson,
    schema,
  });
  assert.equal(scenarios.size, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'unsupportedSchemaVersion');
});

test('loading both 07-duplicate-id-a and 07-duplicate-id-b throws Error with code duplicateScenarioId and registers nothing', async () => {
  await assert.rejects(
    loadAllWithIds(['07-duplicate-id-a', '07-duplicate-id-b'], {
      fetchScenarioJson,
      schema,
    }),
    (e) => e instanceof Error && e.code === 'duplicateScenarioId',
  );
});
