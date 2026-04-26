import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../extension/lib/schema-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const schemaPath = path.join(repoRoot, 'schema/scenario.schema.json');
const fixturesDir = path.join(__dirname, 'fixtures/scenarios');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

test('fixtures: schema-valid scenarios validate', () => {
  for (const id of ['01-valid-minimal', '02-valid-all-steps', '03-valid-with-evaluate']) {
    const r = validate(schema, loadFixture(id));
    assert.equal(r.valid, true, id);
  }
});

test('fixtures: 07 duplicate-id files each validate in isolation', () => {
  for (const id of ['07-duplicate-id-a', '07-duplicate-id-b']) {
    const r = validate(schema, loadFixture(id));
    assert.equal(r.valid, true, id);
  }
});

test('fixtures: schema-invalid scenarios fail validation', () => {
  for (const id of ['04-invalid-bad-schemaversion', '05-invalid-non-absolute-filepath', '06-invalid-missing-required']) {
    const r = validate(schema, loadFixture(id));
    assert.equal(r.valid, false, id);
  }
});

test('rejects unsupported keyword', () => {
  assert.throws(
    () => validate({ type: 'string', format: 'uri' }, 'https://a'),
    /schema feature not supported in v0.01: format/,
  );
});

test('discriminated oneOf picks the right branch', () => {
  const stepSchema = {
    oneOf: [
      {
        type: 'object',
        required: ['type', 'url'],
        additionalProperties: false,
        properties: {
          type: { const: 'navigate' },
          url: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['type', 'selector', 'filePath'],
        additionalProperties: false,
        properties: {
          type: { const: 'uploadFile' },
          selector: { type: 'string' },
          filePath: { type: 'string', pattern: '^/' },
        },
      },
    ],
  };
  const r = validate(stepSchema, {
    type: 'uploadFile',
    selector: 'input[type=file]',
    filePath: 'relative/path.pdf',
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path.includes('filePath')));
  assert.ok(!r.errors.some((e) => e.path.includes('url')));
});
