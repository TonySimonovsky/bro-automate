// scenario-loader.js — discovers + validates scenarios at startup (TDD §7.1, §16.2).
// v0.01 uses a hardcoded index of bundled scenario folder names because Chrome MV3 has no
// directory-listing API. Soft-skip on unsupportedSchemaVersion; hard-fail on duplicate id.
// TDD: §7.1
// Tasks: T-203
// Wave: 2
// Status: implemented (Wave 2)

import { validate } from './schema-validator.js';
import * as log from './log.js';

const SUPPORTED_SCHEMA_VERSION = '1';

/**
 * Bundled packaged scenario folders (TDD §7.1). NFR-M3 forbids vendor-specific *logic* in
 * `extension/lib`; bundled scenario *identifiers* are configuration data, not logic, and are
 * explicitly enumerated by TDD §7.1, so the literal strings stay readable here.
 */
export const KNOWN_SCENARIO_IDS = [
  'upwork-collect',
  'linkedin-scheduled-posts',
  'local-smoke',
  'test-upload-50mb',
];

export function bundledScenarioFolderIds() {
  return KNOWN_SCENARIO_IDS.slice();
}

/**
 * @param {{ fetchScenarioJson: (id: string) => Promise<object>, schema: object }} options
 */
export async function loadAll(options) {
  return loadAllWithIds(bundledScenarioFolderIds(), options);
}

/**
 * @param {string[]} ids
 * @param {{ fetchScenarioJson: (id: string) => Promise<object>, schema: object }} options
 */
export async function loadAllWithIds(ids, options) {
  const { fetchScenarioJson, schema } = options;
  /** @type {Map<string, object>} */
  const scenarios = new Map();
  /** @type {{ id: string, reason: string }[]} */
  const skipped = [];
  /** @type {{ json: object }[]} */
  const loaded = [];

  for (const folderKey of ids) {
    /** @type {object} */
    let json;
    try {
      json = await fetchScenarioJson(folderKey);
    } catch (e) {
      log.error('scenario-loader', { id: folderKey }, String(e));
      throw e;
    }

    if (String(json.schemaVersion) !== SUPPORTED_SCHEMA_VERSION) {
      skipped.push({ id: folderKey, reason: 'unsupportedSchemaVersion' });
      log.warn('scenario-loader', { id: folderKey }, 'unsupported scenario schemaVersion; skipping');
      continue;
    }

    const result = validate(schema, json);
    if (!result.valid) {
      const err = new Error(
        `scenario validation failed for ${folderKey}: ${JSON.stringify(result.errors)}`,
      );
      throw err;
    }

    loaded.push({ json });
  }

  const seenScenarioIds = new Map();
  for (const { json } of loaded) {
    const sid = json.id;
    if (seenScenarioIds.has(sid)) {
      const err = new Error('duplicateScenarioId');
      err.code = 'duplicateScenarioId';
      throw err;
    }
    seenScenarioIds.set(sid, true);
  }

  for (const { json } of loaded) {
    scenarios.set(json.id, json);
  }

  return { scenarios, skipped };
}

/**
 * @param {Record<string, never>} [_opts]
 */
export function bindToChrome(_opts) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
}
