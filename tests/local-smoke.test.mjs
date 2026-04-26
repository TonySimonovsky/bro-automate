import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../extension/lib/schema-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const schema = JSON.parse(readFileSync(path.join(repoRoot, 'schema/scenario.schema.json'), 'utf8'));
const scenario = JSON.parse(readFileSync(path.join(repoRoot, 'extension/scenarios/local-smoke/scenario.json'), 'utf8'));

test('local-smoke scenario validates and has deterministic 5-step shape', () => {
  const r = validate(schema, scenario);
  assert.equal(r.valid, true, r.valid === false ? JSON.stringify(r.errors) : '');
  assert.equal(scenario.id, 'local-smoke');
  assert.deepEqual(scenario.steps.map((s) => s.type), ['navigate', 'waitForSelector', 'click', 'waitForText', 'extract']);
});

test('local-smoke server starts and serves test page', async () => {
  const serverPath = path.join(__dirname, 'local-smoke/server.mjs');
  const child = spawn(process.execPath, [serverPath, '--port', '0'], { cwd: repoRoot });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  try {
    const url = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server start timeout')), 5000);
      child.stdout.on('data', () => {
        const m = stdout.match(/served-on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== null && !stdout.includes('served-on')) reject(new Error('server exited ' + code));
      });
    });
    const res = await fetch(url);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /id="ready"/);
    assert.match(text, /id="increment"/);
    assert.match(text, /count: 0/);
  } finally {
    child.kill('SIGTERM');
  }
});
