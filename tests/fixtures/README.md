# `tests/fixtures`

## Purpose

These files support **Wave 2** tests:

- **`scenarios/*.json` —** inputs for `extension/lib/schema-validator.js` and `extension/lib/scenario-loader.js` (and any Node test harnesses that exercise them).
- **`run.mjs` —** a tiny structural check (JSON parse, expected `schemaVersion` / `name` / `filePath` / duplicate `id` shapes) that does **not** depend on the schema validator, so it can run as soon as fixtures land (Wave 1).

## Scenario fixtures

| File | Category | Expected refusal error code (TDD §10) | Description |
|------|----------|----------------------------------------|-------------|
| `01-valid-minimal.json` | schema-valid | — | Minimal valid scenario: one `navigate` step. |
| `02-valid-all-steps.json` | schema-valid | — | Single scenario listing all **14** v0.01 step types for coverage. |
| `03-valid-with-evaluate.json` | schema-valid | — | Uses `module` + `evaluate` (mirrors the `upwork-collect` pattern). |
| `04-invalid-bad-schemaversion.json` | schema-invalid* | `unsupportedSchemaVersion` | `schemaVersion` is `"999"`, not supported by the extension in v0.01. |
| `05-invalid-non-absolute-filepath.json` | schema-invalid | — | `uploadFile.filePath` violates the absolute-path `pattern` (`^/`). |
| `06-invalid-missing-required.json` | schema-invalid | — | Missing required top-level `name` (fails `required` in the schema). |
| `07-duplicate-id-a.json` | loader-invalid | `duplicateScenarioId` | Each file is **individually** schema-valid; the pair is invalid only when the loader registers both. |
| `07-duplicate-id-b.json` | loader-invalid | `duplicateScenarioId` | Same `id` as `07-duplicate-id-a.json` (see above). |

\*For `04-invalid-bad-schemaversion.json`, a strict read of the canonical schema also fails the `schemaVersion` `const: "1"` check. The **intended** product behavior (TDD §7.1, PRD `FR-V3`) is to surface `unsupportedSchemaVersion` when the running extension does not support the declared version—so Wave 2 may implement version gating as a first-class check instead of (or in addition to) a generic `const` error.

## Why duplicate `id` is not a schema concern

**JSON Schema describes one document at a time.** Uniqueness of `id` across multiple scenario files is a **registry / loader** invariant (PRD `FR-S5`, TDD §7.1): the scenario loader must reject the startup set when two loaded scenarios share an `id`. No single `scenario.json` can express that constraint, so it belongs in `scenario-loader.js`, not in `schema/scenario.schema.json`.
