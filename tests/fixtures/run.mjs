#!/usr/bin/env node
/**
 * Structural smoke checks for Wave-1 scenario fixtures (JSON parse + expected shapes).
 * Does not load the JSON Schema or the Wave-2 schema validator.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(__dirname, "scenarios");

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

const files = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

assert.ok(files.length > 0, "expected at least one fixture .json under scenarios/");

const byName = {};
for (const name of files) {
  const full = path.join(scenariosDir, name);
  const data = readJson(full);
  byName[name] = data;
  console.log(`OK JSON.parse: ${name}`);
}

const expectV1 = [
  "01-valid-minimal.json",
  "02-valid-all-steps.json",
  "03-valid-with-evaluate.json",
  "07-duplicate-id-a.json",
  "07-duplicate-id-b.json",
];

for (const n of expectV1) {
  assert.strictEqual(byName[n].schemaVersion, "1", n);
  console.log(`OK schemaVersion === "1": ${n}`);
}

assert.strictEqual(byName["04-invalid-bad-schemaversion.json"].schemaVersion, "999");
console.log('OK schemaVersion === "999": 04-invalid-bad-schemaversion.json');

assert.strictEqual(Object.prototype.hasOwnProperty.call(byName["06-invalid-missing-required.json"], "name"), false);
console.log('OK missing top-level "name": 06-invalid-missing-required.json');

const uploadSteps = byName["05-invalid-non-absolute-filepath.json"].steps.filter((s) => s.type === "uploadFile");
assert.ok(uploadSteps.length >= 1, "05 should include an uploadFile step");
assert.ok(typeof uploadSteps[0].filePath === "string");
assert.ok(!uploadSteps[0].filePath.startsWith("/"), "filePath should be non-absolute");
console.log("OK uploadFile.filePath does not start with \"/\": 05-invalid-non-absolute-filepath.json");

const idA = byName["07-duplicate-id-a.json"].id;
const idB = byName["07-duplicate-id-b.json"].id;
assert.strictEqual(idA, idB);
assert.strictEqual(idA, "dup-test");
console.log('OK duplicate-id pair share id "dup-test": 07-duplicate-id-a.json + 07-duplicate-id-b.json');
