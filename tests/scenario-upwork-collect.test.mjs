import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../extension/lib/schema-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const scenarioPath = path.join(repoRoot, 'extension/scenarios/upwork-collect/scenario.json');
const scenarioJsPath = path.join(repoRoot, 'extension/scenarios/upwork-collect/scenario.js');
const schemaPath = path.join(repoRoot, 'schema/scenario.schema.json');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const scenarioJsSource = readFileSync(scenarioJsPath, 'utf8');

test('upwork-collect scenario.json validates against schema', () => {
  const r = validate(schema, scenario);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('scenario.js installs exports and re-injection is a no-op', () => {
  const context = vm.createContext({
    window: {
      location: {
        href: 'https://www.upwork.com/ab/notifications/',
        pathname: '/ab/notifications/',
        origin: 'https://www.upwork.com',
      },
    },
    document: { body: { textContent: '' }, querySelector: () => null, querySelectorAll: () => [] },
    setTimeout: globalThis.setTimeout,
  });

  vm.runInContext(scenarioJsSource, context);

  const ns = context['__broScenario_upwork-collect'];
  assert.ok(ns && typeof ns === 'object', 'namespace object');
  const names = [
    'resolveJobUrls',
    'scrapeAll',
    'collectJobLinks',
    'clickViewMore',
    'extract',
    'detectBlockedPage',
    'loginRequired',
  ];
  for (const n of names) {
    assert.equal(typeof ns[n], 'function', n);
  }

  const firstRef = context['__broScenario_upwork-collect'];
  vm.runInContext(scenarioJsSource, context);
  assert.strictEqual(context['__broScenario_upwork-collect'], firstRef);
});

test('resolveJobUrls: jobIds → urls', () => {
  const context = vm.createContext({
    window: {
      location: {
        href: 'https://www.upwork.com/',
        pathname: '/',
        origin: 'https://www.upwork.com',
      },
    },
    document: { body: { textContent: '' }, querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(scenarioJsSource, context);
  const ns = context['__broScenario_upwork-collect'];
  const r = ns.resolveJobUrls({ jobIds: ['1234'] });
  assert.equal(r.urls.length, 1);
  assert.equal(String(r.urls[0]), 'https://www.upwork.com/jobs/~1234');
});

test('resolveJobUrls: jobUrls passthrough', () => {
  const context = vm.createContext({
    window: {
      location: { href: 'https://www.upwork.com/', pathname: '/', origin: 'https://www.upwork.com' },
    },
    document: { body: { textContent: '' }, querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(scenarioJsSource, context);
  const ns = context['__broScenario_upwork-collect'];
  const urls = ['https://www.upwork.com/jobs/~99'];
  const r = ns.resolveJobUrls({ jobUrls: urls });
  assert.equal(r.urls.length, 1);
  assert.equal(String(r.urls[0]), urls[0]);
});

test('resolveJobUrls: missing shape throws internal', () => {
  const context = vm.createContext({
    window: {
      location: { href: 'https://www.upwork.com/', pathname: '/', origin: 'https://www.upwork.com' },
    },
    document: { body: { textContent: '' }, querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(scenarioJsSource, context);
  const ns = context['__broScenario_upwork-collect'];
  assert.throws(
    () => ns.resolveJobUrls({}),
    (err) => Boolean(err && err.code === 'internal' && String(err.message).includes('jobIds')),
  );
});
