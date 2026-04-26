# Upload 50 MB test rig (T-6, DoD-P6, Gate-3 smoke)

This folder is **not** part of the bundled extension scenarios. It provides a static page, a tiny static server, a throwaway `scenario.json` for `uploadFile`, and a Node integration test for `file-transfer` against the real native host.

## Scenario id and schema

`scenario.json` uses id `test-upload-50mb` (lowercase, digits, hyphens) so it validates against `schema/scenario.schema.json` (`^[a-z0-9-]+$` does not allow underscore characters). The original “`_test-…`” id from the spec was adjusted for schema compliance; update any operator notes that referred to the underscore form.

## Operator: Gate-3 browser smoke (uploadFile + page status)

1. **Create the 50 MB file (operator path, fixed in the scenario)**

   ```bash
   dd if=/dev/urandom of=/tmp/bro-automate-test-50mb.bin bs=1m count=50
   ```

2. **Start the static server** (port must match `scenario.json` if you do not edit it)

   ```bash
   node tests/upload-50mb/server.mjs --port 8765
   ```

3. (Optional) Open the page: `http://127.0.0.1:8765/`

4. Load the **built** Bro Automate extension in Chrome and ensure the **native host** is available (normal dev setup).

5. **Register the scenario** — `test-upload-50mb` is **not** in `extension/lib/scenario-loader.js` `KNOWN_SCENARIO_IDS` and the scenario does not live under `extension/scenarios/` by default. For a one-off smoke, use the **simplest** path:

   - Create `extension/scenarios/test-upload-50mb/` and copy the contents of `tests/upload-50mb/test-scenario/` there (`scenario.json` + `scenario.js`).
   - Temporarily add `test-upload-50mb` to `KNOWN_SCENARIO_IDS` in `extension/lib/scenario-loader.js`.
   - After the test, **revert** those edits and remove the extra scenario folder if you do not need it.

   There is no separate “ad-hoc load” action in the CLI; copying into `extension/scenarios/` is the supported way to make `runScenario` see this id.

6. **Run the scenario** (JSON on stdin is the `bro` contract; adjust `scenarioId` if you changed the id)

   ```bash
   node cli/bro.js '{"action":"runScenario","scenarioId":"test-upload-50mb","requestId":"upload-smoke"}'
   ```

7. **Expected**

   - Terminal: `runScenarioResult` with `ok: true` (or equivalent success in your trace).
   - Page: `#status` text includes  
     `file:test-50mb.bin bytes:52428800 type:application/octet-stream`

   If you use a different port or file path, edit `test-scenario/scenario.json` accordingly (first step `navigate` URL, `uploadFile` `filePath`).

## Node integration test (no Chrome)

Exercises `serveFile` + `fetchToBlob` + one-time URL + 51 MB `serveFile` size reporting against a spawned `native-host/host.js`:

```bash
node --test --test-force-exit tests/upload-50mb/integration.test.mjs
```

If a **50 MB** run is too slow (e.g. over ~60 s wall-clock for case 1 on your machine), force a **5 MB** round-trip (same assertions, different size) with:

```bash
BRO_UPLOAD_INTEGRATION_BYTES=5242880 node --test --test-force-exit tests/upload-50mb/integration.test.mjs
```

Revisit **Wave 5 Gate 2 / Gate 3** for the canonical full **50 MB** run on representative hardware.

## Note on the whole `tests/` suite

CI and the recommended local command run every `tests/**/*.test.mjs` (including `upload-50mb/integration.test.mjs`).
