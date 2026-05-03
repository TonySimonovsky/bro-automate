---
# Machine-readable metadata (YAML 1.2). Parse with a YAML frontmatter stripper.
audience: autonomous-agents
component: bro-automate
kind: chrome-extension-mv3-node-bridge
display_name: "Bro Automate"
manifest_version: 3
extension_version: "0.0.3"
protocols:
  cdp: "1.3"
network:
  bridge_server:
    host: "127.0.0.1"
    port: 7823
    base_url: "http://localhost:7823"
agent_entrypoint:
  description: "All control is via HTTP JSON to the bridge; the extension pulls commands from the same process."
  base_url: "http://localhost:7823"
extension_constants:
  server_url: "http://localhost:7823"
  long_poll_timeout_ms: 35000
  command_timeout_ms: 300000
  processed_cache_limit: 64
  event_ring_limit: 50
capabilities:
  - long_poll_command_bridge
  - atomic_cdp_via_chrome_debugger_api
  - scenario_runner_vm
  - idempotent_replay_on_sw_restart
# Scenario Package = on-disk bundle passed as POST /run-scenario body field scenarioPath (see scenario_path_contract).
scenario_path_contract:
  display_name: Scenario Package
  api_field_root_path: scenarioPath
  resolution: "path.resolve(scenarioPath) — relative paths are relative to the Node process current working directory."
  root_directory:
    must_exist: true
    must_be_readable_directory: true
    note: "If readdir fails, the run fails (HTTP 500). The runner does not create the Scenario Package root."
  step_discovery:
    source: "fs.readdirSync(absPath) on the root only (non-recursive)."
    include_pattern: "^step-\\d+$"
    sort_order: "Ascending by the numeric suffix after 'step-' (e.g. step-2 before step-10)."
    ignored_entries: "Root children whose names do not match include_pattern are dropped by the filter in runScenario (server.js); they are never treated as steps."
    empty_steps: "If no directory matches, the run still creates/attaches a tab, runs zero steps, then teardown (tab closes on success)."
  each_step_directory:
    path: "<resolved Scenario Package root>/<step-N>/"
    filenames_read_by_runner:
      - name: execute.cdp.js
        role: "execute phase script (Node vm)"
        required: false
      - name: verify.cdp.js
        role: "verify phase script (Node vm)"
        required: false
    other_files: "The runner only checks execute.cdp.js and verify.cdp.js by fixed pathname; it does not enumerate or require other paths under the step directory."
  filenames_case_sensitive: true
  run_artifacts_log:
    location: "Separate from the Scenario Package directory: path.resolve('tmp')/rpa-run-<ISO8601-with-:-and-.-replaced>.log.json on the bridge host (same cwd semantics as scenarioPath)."
  agent_only:
    input_json:
      path: "<Scenario Package root>/input.json"
      read_by_bridge: false
      read_by_extension: false
      purpose: "Documents which keys belong in POST /run-scenario body.params (required vs optional) for autonomous agents; not loaded or validated by server.js or the extension."
---

# Bro Automate — agent usage

**Purpose:** Drive Chrome programmatically by sending **JSON commands** to a local HTTP bridge. The bridge forwards work to a Manifest V3 extension that runs **Chrome DevTools Protocol (CDP 1.3)** calls on tabs via `chrome.debugger`. You either send **atomic commands** (`POST /command`) or run a **Scenario Package** (`POST /run-scenario`): a directory on the bridge host whose path you pass as **`scenarioPath`** (see [Scenario Package layout](#scenario-package-layout)).

**Assume:** `GET http://localhost:7823/status` returns HTTP 200 (bridge up). The attached extension long-polls `GET /next` on that same host so commands complete.

---

## Which API to use

| Goal | Use |
|------|-----|
| One-off tab list, navigate, evaluate JS, DOM snapshot, etc. | `POST /command` with the appropriate `type` (usually `cdp` after `attach`). |
| Multi-step flow packaged as a **Scenario Package** (`step-1` … `step-N` on disk) | `POST /run-scenario` with `scenarioPath` set to the Scenario Package root. Step scripts run in **Node** (`vm`); each `chrome.debugger.sendCommand` becomes a `cdp` command through the same bridge. |

Do **not** interleave `POST /command` while `/run-scenario` is active: the server returns **409** (see below).

---

## Agent workflows

### A) Atomic commands (full control) 

Typical sequence for CDP on a **new** tab:

1. `POST /command` → `{ "type": "create-tab", "url": "https://..." }` — capture `tabId` from response.
2. `POST /command` → `{ "type": "attach", "tabId": <id> }`.
3. One or more `POST /command` → `{ "type": "cdp", "tabId": <id>, "method": "<CDP.Method>", "params": { ... } }`.
4. `POST /command` → `{ "type": "detach", "tabId": <id> }`.
5. Optional: `{ "type": "close-tab", "tabId": <id> }`.

For an **existing** tab, discover `tabId` first:

```json
{ "type": "tabs", "query": {} }
```

Response is an array of `{ "id", "url", "title", "active", "windowId" }`. Then `attach` before any `cdp`.

**Blocking behavior:** Each `/command` waits until the extension posts the result or **300s** elapses (`success: false`, `error` describing timeout).

### B) Run a Scenario Package

Before step 1, agents may read **`input.json`** in the Scenario Package root (if present) to learn required vs optional **`params`** keys; the bridge never loads this file.

1. `POST /run-scenario` with body `{ "scenarioPath": "<Scenario Package root path>", "params": { }, "stopOnFail": true }`.
2. Poll `GET /status` if you need live `currentStep`, `currentPhase`, `currentCommand`, `recentEvents`, or `logFile`.
3. Use the HTTP response body of `/run-scenario` (or `GET /last-run` after completion) as the final outcome.

**Default lifecycle (no `tabId` in the body):** the runner creates a dedicated tab, drops it into a fresh group titled after the last two path segments of `scenarioPath`, and on success **closes** the tab. On failure the tab stays open for inspection (`tabId` in the result).

### B.1) Reusing a tab across runs (single‑working‑tab workflow)

If the agent is supposed to operate within **one** tab and **one** group across many `/run-scenario` invocations (a common constraint when the workflow says "create one group named X with one tab and use only that"), pass that tab's id as **`tabId`** on every `/run-scenario` request. The runner will reuse it instead of forking a new tab and group on each run.

**Lifecycle when `tabId` is supplied:**

| Phase | Behavior |
|-------|----------|
| Setup | Validates the tab still exists via `tabs`. Errors HTTP 500 if it doesn't (no silent fallback to creating a replacement). Skips `create-tab` and `group-tab` entirely. |
| Steps | `attach` → run `step-N/execute.cdp.js` + `verify.cdp.js` exactly as in default mode. |
| Teardown | `detach` always. **Never** `close-tab`. The tab is left in whatever state the last step produced — caller owns it. The group is never moved or renamed. |
| Failure | Same as success teardown: detach, leave the tab in place. (No "leave for inspection" branch — it was already the caller's, and the caller already had it.) |

**Recommended bootstrap pattern** for a session that owns its own tab + group:

1. **First `/run-scenario` of the session — create the tab + group via atomic commands first**, then pass the tab id forward:
   ```bash
   # 1. Create the working tab
   curl -sS -X POST http://localhost:7823/command -H 'Content-Type: application/json' \
     -d '{"type":"create-tab","url":"about:blank"}'
   # → { "success": true, "tabId": 12345, "windowId": ... } — keep tabId

   # 2. Group it under your scenario prefix
   curl -sS -X POST http://localhost:7823/command -H 'Content-Type: application/json' \
     -d '{"type":"group-tab","tabId":12345,"title":"linkedin/publish-post","color":"blue"}'
   # → { "success": true, "groupId": 67890 }
   ```
2. **Every subsequent `/run-scenario`** in the session — pass the same `tabId`:
   ```bash
   curl -sS -X POST http://localhost:7823/run-scenario -H 'Content-Type: application/json' \
     -d '{"scenarioPath":"/abs/path/to/package","tabId":12345,"params":{...}}'
   ```
3. **Atomic exploration commands** (`POST /command` with `cdp` / `Runtime.evaluate` / etc.) all accept `tabId` already — point them at the same `12345` and the agent stays inside one tab the whole time.
4. **At end of session** (optional): `{"type":"close-tab","tabId":12345}`.

**Caller obligations when reusing a tab.** Because the runner no longer normalizes the page state at start or end, the scenario package itself must be **idempotent across reuses**:

- **Step 1 must be defensive.** Don't assume a clean DOM. Common residue between runs: an open populated composer (LinkedIn's "What do you want to talk about?" modal still showing the previous post and triggering a `beforeunload`/unsaved-changes dialog), a half-finished sub-modal (date picker, file uploader, schedule modal), a toast still on screen, a modal that was dismissed but left `display:block` residue (Antd-style closed-modal residue is real on many design systems — see the knowledgebase). Write step 1 to *clear* that state before navigating: dismiss any open dialogs, abort any in-flight uploads, then navigate.
- **Avoid `Page.navigate` to the same URL.** It is a no-op for SPA hash routes and may also fire `beforeunload` if the page has unsaved state. Prefer either a hard `Page.reload` after clearing state, or a navigation to a known-clean route (`about:blank` → target URL) when you genuinely need a fresh DOM.
- **Don't rely on tab close as an implicit reset.** It won't happen. If your verify expectations leak across runs (e.g. "list now contains row X"), make them strict equality on the new state, not "appended".
- **Hand the tab back clean if you can.** When the scenario logically completes (e.g. publish succeeds and the modal closes), the tab is naturally left on a clean feed page — perfect for the next run. When it doesn't (a half-built scenario that ends mid-modal during exploration), accept that the next run's step 1 has to clean up.

**When NOT to use `tabId`:** one-off ad-hoc invocations where you have no reason to keep the tab around afterwards, or scenarios where any leftover state would be unsafe (e.g. logged-in tabs you don't want to keep open). Plain `/run-scenario` without `tabId` is still the right tool for those.

**Debugger contention.** Chrome only allows one debugger client per tab. If something else is already attached to your reused tab (DevTools, another `/run-scenario` that crashed without detaching), the next attach fails. Within a single agent session this is rare because the runner always detaches in its teardown, but if you see `Cannot attach to this target` errors, manually `{"type":"detach","tabId":...}` once via `/command` and retry.

### C) Monitoring long work

- `GET /status` — includes `recentEvents` (ring buffer) and optional `?tail=N`.
- While idle after a run: `inFlight: false`, `lastRunSuccess`, `lastRunLogFile`.

---

## HTTP API

**Base URL:** `http://localhost:7823`  
**CORS:** `Access-Control-Allow-Origin: *` (JSON `POST` usable from browser contexts if needed).

### `POST /command`

**Body:** JSON object with required `type` (see [Command types](#command-types)). The server assigns `_cmdId` internally; do not send `_cmdId` yourself unless debugging command replay (normally omit).

**Success:** HTTP 200 + JSON result (per command).

**Timeout:** Still 200 with `{ "success": false, "error": "Extension did not respond within 300s" }` after server-side timeout.

**Conflict — HTTP 409** while a Scenario Package run (`/run-scenario`) holds the queue:

```json
{
  "success": false,
  "error": "run-scenario in flight; refusing /command to avoid corrupting the queue. Wait for run to finish or call GET /status."
}
```

**Agent rule:** If 409, poll `/status` until `inFlight` is false, then retry or abandon.

### `POST /run-scenario`

**Body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scenarioPath` | string | yes | — | Path to the **Scenario Package** root (directory that contains `step-<n>/` subdirectories) |
| `params` | object | no | `{}` | Passed into `execute(tabId, params)` / `verify(tabId, params)` in each step script. Agents can discover expected keys from optional **`input.json`** in the Scenario Package (see [Scenario Package layout](#scenario-package-layout)); the bridge does not read that file. |
| `stopOnFail` | boolean | no | `true` | Stop after first failing execute or verify |
| `tabId` | integer | no | — | Existing tab to reuse for this run (see [Reusing a tab across runs](#reusing-a-tab-across-runs-singleworkingtab-workflow)). When omitted, the runner creates a fresh tab + group as before. When provided, the runner validates the tab still exists, attaches to it, runs the steps, detaches, and **leaves the tab open in whatever state the last step produced** — the runner never closes a caller-owned tab. The tab's group membership is unchanged: the runner does not move it or rename its group. |

**Response:** HTTP 200 + run snapshot JSON (see [Run result](#run-result)). The snapshot includes `tabOwned` — `true` if the runner created the tab, `false` if the caller passed `tabId`.

**Side effects:** Writes a JSON log file under `tmp/rpa-run-<timestamp>.log.json` relative to the **Node process current working directory**. **When `tabId` is omitted:** creates one tab, groups it, runs steps, **detach**es always, closes tab only if `success`. **When `tabId` is provided:** runs steps on that tab, **detach**es always, **never closes** the tab and never alters the group.

**Errors:** HTTP 400 if `scenarioPath` missing; HTTP 500 with `{ "error": "<message>" }` on runner failure (including: caller passed `tabId` that no longer exists; debugger could not attach because another client is already attached).

### `GET /status` · `GET /status?tail=<n>`

Returns JSON: when a run is active, `inFlight`, `scenarioPath` (resolved absolute path of the Scenario Package), `tabId`, `currentStep`, `currentPhase`, `stepsDone`, `totalStepsKnown`, `currentCommand` (payload summary), `logFile`, `recentEvents`. When idle, `inFlight: false` plus optional last-run hints.

### `GET /last-run`

Returns the last completed Scenario Package run snapshot (`run-scenario` result JSON), or `null`.

### Internal (extension ↔ server)

Agents normally ignore these. The extension calls `GET /next` (long-poll, **30s** → **204** empty) and `POST /done` with the JSON result.

**Do not** call `GET /next` yourself (e.g. with `curl`) for ad-hoc testing unless you implement the full pair: **receive** the command body from `GET /next`, then **`POST /done`** with a JSON result body for that same command. The bridge delivers each queued command to **whichever client hits `/next` first**. If you take a command and never `POST /done`, the extension never sees that work and `POST /command` / `POST /run-scenario` can **block** until the server command timeout (**300s**) or remain confusingly stuck. Use **`POST /command`** and the extension’s poll loop for normal tests.

---

## Command types

Extension responses are either `{ "success": true, ... }` or `{ "success": false, "error": "<string>" }`. CDP successes add `{ "result": <CDP domain return value> }`.

### `tabs`

```json
{ "type": "tabs", "query": {} }
```

`query` optional; passed to `chrome.tabs.query`. **Returns:** array of `{ "id", "url", "title", "active", "windowId" }`.

### `attach`

```json
{ "type": "attach", "tabId": <number> }
```

CDP protocol version **1.3**. **Returns:** `{ "success": true }`.

### `detach`

```json
{ "type": "detach", "tabId": <number> }
```

### `cdp`

```json
{
  "type": "cdp",
  "tabId": <number>,
  "method": "<Domain.method>",
  "params": {}
}
```

`params` optional. Use standard [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) method names and parameter objects.

### `create-tab`

```json
{ "type": "create-tab", "url": "https://example.com" }
```

`url` optional (default `about:blank`). **Returns:** `{ "success": true, "tabId", "windowId" }`.

### `close-tab`

```json
{ "type": "close-tab", "tabId": <number> }
```

### `group-tab`

```json
{ "type": "group-tab", "tabId": <number>, "title": "", "color": "blue" }
```

**Returns:** `{ "success": true, "groupId" }`.

---

## Scenario Package layout

A **Scenario Package** is the **directory** on the bridge host that contains your `step-<n>/` tree. In HTTP JSON it is always referenced by the field **`scenarioPath`** (same path the server resolves with `path.resolve` in `server.js`).

`POST /run-scenario` expects **`scenarioPath`** to be the Scenario Package root — a **directory path on the machine running the bridge** (not inside Chrome). It is normalized with **`path.resolve(...)`**: absolute paths are used as-is; relative paths are relative to the **Node process current working directory**, not the Scenario Package’s parent unless you `cd` there first.

### Scenario Package root

| Requirement | Detail |
|-------------|--------|
| Exists | The Scenario Package root must be a readable directory; otherwise the bridge throws when listing it. |
| Discovery | Only **immediate children** of the Scenario Package root are considered. There is **no** recursive search for nested `step-*`. |
| Step dirs | Include **only** subdirectories whose **entire name** matches **`^step-\d+$`** (e.g. `step-1`, `step-12`, `step-0`). |
| Execution order | Sorted by the **integer** after `step-`, ascending (`step-2` runs before `step-10`). |
| Everything else | Root entries whose **names** do not match `^step-\d+$` are omitted by `.filter` in `server.js` — not errors. Only **directories** matching the pattern are steps. Files at the root (including **`input.json`**) are never opened by the bridge for execution; see **`input.json` (agents only)** below. |

A **minimal** Scenario Package is only `step-1/`, `step-2/`, … as needed. If **no** directory matches the pattern, the run still opens a tab and performs teardown with **zero** steps (then closes the tab if nothing failed).

### `input.json` at the Scenario Package root (agents only)

**Not used by the bridge or extension.** `server.js` only uses the package root listing to find `step-<n>/` directories; it does not read `input.json`.

**Purpose:** Tell autonomous agents which **`params`** keys belong in `POST /run-scenario` and which are required vs optional.

**Path:** `<Scenario Package root>/input.json` (the directory passed as `scenarioPath`).

**Recommended shape** (convention for agents and tooling — not validated by the bridge):

```json
{
  "required": ["startUrl"],
  "optional": ["maxWaitMs"],
  "descriptions": {
    "startUrl": "Initial navigation target passed to step scripts.",
    "maxWaitMs": "Optional cap on waits; scripts may define their own default."
  }
}
```

- **`required`**: string keys agents should normally supply under `params`.
- **`optional`**: keys step scripts may honor if present.
- **`descriptions`**: optional; keys should match entries above.

Values in **`params`** are forwarded verbatim to `execute(tabId, params)` and `verify(tabId, params)`; keep `input.json` aligned with how scripts read `params`.

### Inside each `step-<n>/` directory of the Scenario Package

| Entry | Role |
|-------|------|
| **`execute.cdp.js`** | If present, loaded and run as the **execute** phase; exact filename, case-sensitive on typical Unix hosts. |
| **`verify.cdp.js`** | Same for the **verify** phase. |
| Other paths | Never opened by the runner; only `execute.cdp.js` and `verify.cdp.js` are considered (via `path.join(stepPath, ...)` + `existsSync` in `server.js`). |

### Layout (paths the runner loads)

```text
<Scenario Package root>/    # same directory as request field scenarioPath (after path.resolve)
  input.json                  # optional: required/optional params for agents; bridge never reads
  step-1/
    execute.cdp.js
    verify.cdp.js
  step-2/
    execute.cdp.js
    verify.cdp.js
  step-3/
    execute.cdp.js
```

Step 3 omits `verify.cdp.js` only to show the real outcome **`verifySkipped`** when that file is missing (see `server.js`); it is not an extra file type you must add.

Run JSON logs written by the bridge live under **`tmp/rpa-run-*.log.json`** (resolved from the bridge process **`path.resolve('tmp')`**), not inside the Scenario Package unless you place a `tmp` directory accordingly **and** the server cwd matches — see frontmatter `scenario_path_contract.run_artifacts_log`.

### Missing `execute` / `verify` files

The runner does not require both scripts in every step directory of the Scenario Package. If `execute.cdp.js` or `verify.cdp.js` is **missing**, that phase is **skipped** (not treated as failure) and the step record gets `executeSkipped: true` or `verifySkipped: true`. Implementation (`fs.existsSync` before each phase):

```258:262:extension/server.js
    // --- execute ---
    const execFile = path.join(stepPath, 'execute.cdp.js');
    if (!fs.existsSync(execFile)) {
      step.executeSkipped = true;
    } else {
```

```293:297:extension/server.js
    // --- verify ---
    const verifyFile = path.join(stepPath, 'verify.cdp.js');
    if (!fs.existsSync(verifyFile)) {
      step.verifySkipped = true;
    } else {
```

Step discovery on the Scenario Package root (`readdirSync`, filter, sort):

```209:212:extension/server.js
  const absPath = path.resolve(scenarioPath);
  const entries = fs.readdirSync(absPath)
    .filter(n => /^step-\d+$/.test(n))
    .sort((a, b) => parseInt(a.replace('step-', ''), 10) - parseInt(b.replace('step-', ''), 10));
```

For agents authoring Scenario Packages: you normally supply both scripts per step; omission only means “no-op for that phase,” which can hide gaps if you forget a file.

---

## Step scripts (`execute.cdp.js` / `verify.cdp.js`)

Files inside each `step-<n>/` directory of a **Scenario Package**. They are loaded only by the **Node bridge** (`server.js`), not by the Chrome extension.

### Contract

#### Where and how scripts run

| Item | Rule |
|------|------|
| Host | Same process as `server.js` (bridge machine). |
| API | Node.js `vm.createContext` + `vm.runInContext(code, sandbox)`; then the bridge calls one exported function by name. |
| Filenames → function names | `execute.cdp.js` must expose a callable **`execute`**. `verify.cdp.js` must expose **`verify`**. |
| Discovery | After `runInContext`, the bridge requires `typeof sandbox[fnName] === 'function'` or it throws (`Function ${fnName} not found in script`). |

Invocation (same `tabId` and `params` for both phases):

```176:203:extension/server.js
// Evaluate a step script in Node.js and call fnName(tabId, params).
// The script declares execute() or verify() at the top level; vm exposes it on the sandbox.
async function runStepFn(code, fnName, tabId, params = {}) {
  const sandbox = vm.createContext({
    chrome: makeChrome(tabId),
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Array,
    Object,
    Error,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    Number,
    String,
    Boolean,
    Map,
    Set,
  });
  vm.runInContext(code, sandbox);
  if (typeof sandbox[fnName] !== 'function') {
    throw new Error(`Function ${fnName} not found in script`);
  }
  return sandbox[fnName](tabId, params);
}
```

#### Function signature

| Argument | Type | Meaning |
|----------|------|--------|
| `tabId` | `number` | Chrome tab id for this Scenario Package run (debugger already **attach**ed before your phase runs). |
| `params` | `object` | Exact object passed as **`params`** on `POST /run-scenario`. Document keys for agents in **`input.json`** at the package root; the bridge does not validate `params` against `input.json`. |

The function may be `async` (recommended); the bridge `await`s the returned thenable.

#### `chrome.debugger.sendCommand` (only supported `chrome` surface)

Semantics come from `makeChrome` in `server.js`:

```162:174:extension/server.js
// Build a chrome shim for use inside vm context.
// Only chrome.debugger.sendCommand is needed by step scripts; everything else goes through the bridge.
function makeChrome(tabId) {
  return {
    debugger: {
      sendCommand: async (target, method, params = {}) => {
        const r = await sendCommand({ type: 'cdp', tabId: target.tabId, method, params });
        if (!r.success) throw new Error(r.error);
        return r.result;
      },
    },
  };
}
```

| Parameter | Contract |
|-----------|----------|
| `target` | Object with numeric **`tabId`**. Convention: pass the **`tabId`** argument your function received. |
| `method` | CDP method string, e.g. `Page.navigate`, `Runtime.evaluate`. |
| `params` | Optional. CDP method parameter object. |
| **Return** | Resolves to **`r.result`** from the extension’s CDP call (the protocol result object for that method). |
| **Errors** | **Throws** `Error` when the extension returns `success: false` for that CDP command. |

**Not supported:** extension-style `sendCommand` with a **callback** (fourth argument), `chrome.runtime`, `chrome.tabs`, `fetch`, `require`, `fs`, `process`, or any API not injected into the sandbox above.

#### Return value → pass / fail (execute and verify)

After your function settles, the bridge treats the step phase as **failed** only if the resolved value is truthy and either flag is explicitly `false`:

```270:271:extension/server.js
        const stepFailed = result && (result.success === false || result.ok === false);
        step.execute = { success: !stepFailed, ms: Date.now() - t0, result };
```

(Same logic for **`verify`**.)

| Returned value | Phase outcome |
|----------------|---------------|
| `undefined` / `null` | **Success** (no explicit failure flag). |
| `{}` or any object with neither `success: false` nor `ok: false` | **Success** |
| `{ success: false, ... }` or `{ ok: false, ... }` | **Failure** (runner applies `stopOnFail`, etc.) |
| Throws | **Failure** (catch path in `server.js` records `error` message). |

You may attach arbitrary fields on success objects (e.g. `{ success: true, url }`); they are stored on the run snapshot.

---

### Example

Minimal **illustrative** step pair. Assume the Scenario Package’s **`input.json`** documents optional `targetUrl` for agents (still not read by the bridge).

**`step-1/execute.cdp.js`**

```javascript
// Contract: top-level async function execute(tabId, params)
async function execute(tabId, params = {}) {
  const url = params.targetUrl ?? 'about:blank';
  await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
  return { success: true, navigatedTo: url };
}
```

**`step-1/verify.cdp.js`**

```javascript
// Contract: top-level async function verify(tabId, params)
async function verify(tabId, params = {}) {
  const evalResult = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    {
      expression: 'document.readyState',
      returnByValue: true,
    },
  );
  const ready = evalResult?.result?.value;
  if (ready === 'complete') {
    return { success: true, ready };
  }
  return { success: false, error: `document.readyState is ${ready}` };
}
```

---

## Run result

Shape returned by `POST /run-scenario` and `GET /last-run` (illustrative). Field **`scenarioPath`** is the resolved absolute path of the Scenario Package that was executed.

```json
{
  "scenarioPath": "/absolute/path/to/scenario-package-root",
  "tabId": 123456789,
  "tabOwned": true,
  "startedAt": "2026-05-01T12:00:00.000Z",
  "finishedAt": "2026-05-01T12:05:00.000Z",
  "success": true,
  "currentStep": null,
  "currentPhase": "finished",
  "steps": [
    {
      "step": 1,
      "dir": "step-1",
      "ts": "2026-05-01T12:00:01.000Z",
      "execute": { "success": true, "ms": 100, "result": {} },
      "verify": { "success": true, "ms": 50, "result": {} },
      "events": ["[rpa-cdp-v002 ...] ..."],
      "done": true
    }
  ],
  "logFile": "/absolute/path/to/tmp/rpa-run-2026-05-01T12-00-00-000Z.log.json"
}
```

`tabOwned` is **`true`** when the runner created the tab itself (default mode) and **`false`** when the caller passed `tabId` on the request. When `tabOwned: false`, the runner does not close the tab regardless of `success`. Failures may set `aborted`, `execute`/`verify` with `error`, and leave `tabId` open in the browser.

---

## Agent-relevant behavior

- **Queue exclusivity:** Only one Scenario Package run (`/run-scenario`) at a time; `/command` is rejected with 409 until it finishes.
- **Command identity:** The server tags outgoing commands with `_cmdId`. If the extension’s service worker restarts mid-flight, the same id may receive a **cached result** instead of duplicate side effects (bounded cache).
- **Navigation drift:** The server logs when an observed URL host/path diverges from the last `Page.navigate` request for that tab (visible in `recentEvents` / stdout).
- **Debugger UX:** Attached tabs show Chrome’s automated-debugger UI; plan waits accordingly.

### Service worker stopped / calls appear hung

**Symptom:** `POST /command` or `POST /run-scenario` blocks for a long time; `GET /status` may show an in-flight run with **`currentCommand`** that never completes. The bridge eventually errors a single command with **`Extension did not respond within 300s`** (see `sendCommand` timeout in `server.js`).

**Architecture (current):** The HTTP poll loop (`GET /next` → execute → `POST /done`) runs in the **offscreen document** (`offscreen.js`), not the service worker. Offscreen documents are **not subject to MV3 idle eviction**. The service worker's only job is to handle privileged commands (`chrome.debugger`, `chrome.tabs`, `chrome.tabGroups`); offscreen forwards each command via `chrome.runtime.sendMessage`, the SW wakes long enough to execute and reply, then is allowed to idle-evict harmlessly.

**Self-heal (built-in):** Offscreen runs a 5 s heartbeat ping against the SW. If three consecutive pings fail (SW deadlocked or refusing to wake), offscreen calls **`chrome.runtime.reload()`** — the extension restarts, the SW recreates the offscreen page from `ensureOffscreen()` on boot, and polling resumes. Typical recovery time: ~1–2 s. **No manual `chrome://extensions` reload should be needed in normal operation.**

**If self-heal isn't kicking in:**

1. Confirm the bridge is up: `curl -sS http://localhost:7823/status` should return JSON in <100 ms. If not, the Node side is stuck — restart `server.js`.
2. Open the extension's **Inspect → service worker** console; look for `[rpa-cdp-v002 offscreen] poll started`. If you see `SW unresponsive — chrome.runtime.reload()` repeatedly, the watchdog is firing but something keeps re-killing it (rare; usually a Chrome bug — manual reload at `chrome://extensions` clears it).
3. Confirm offscreen is alive: from the extension card, **Inspect → offscreen.html**. If the offscreen window is missing, the SW's `ensureOffscreen()` failed; manual reload at `chrome://extensions` recreates it.
4. If the Node bridge is stuck (e.g. something called `GET /next` without `POST /done`, such as a stray `curl`), restart `server.js`.

---

## Data model

```text
[Agent]  --POST /command, /run-scenario-->  [Node bridge :7823]
                                              |
                       offscreen long-poll GET /next  |  POST /done { result }
                                              v
                                    [Extension offscreen document]   ← always-on
                                              |
                              chrome.runtime.sendMessage({type:'cmd'})
                                              v
                                    [Extension service worker]       ← wakes per command,
                                              |                         idle-evicts between
                                   chrome.debugger (CDP 1.3)
                                              v
                                       [Target tab(s)]

  Watchdog: offscreen pings the SW every 5 s. After 3 failures
  → chrome.runtime.reload() — extension restarts and resumes.
```

---

## JSON Schema (`POST /command` body)

Informal validator-oriented schema for command payloads (version `2.0`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://local.invalid/schemas/rpa-cdp-v002/command.json",
  "oneOf": [
    { "type": "object", "required": ["type"], "properties": { "type": { "const": "tabs" }, "query": { "type": "object" } } },
    { "type": "object", "required": ["type", "tabId"], "properties": { "type": { "const": "attach" }, "tabId": { "type": "integer" } } },
    { "type": "object", "required": ["type", "tabId"], "properties": { "type": { "const": "detach" }, "tabId": { "type": "integer" } } },
    { "type": "object", "required": ["type", "tabId", "method"], "properties": { "type": { "const": "cdp" }, "tabId": { "type": "integer" }, "method": { "type": "string" }, "params": { "type": "object" } } },
    { "type": "object", "required": ["type"], "properties": { "type": { "const": "create-tab" }, "url": { "type": "string" } } },
    { "type": "object", "required": ["type", "tabId"], "properties": { "type": { "const": "close-tab" }, "tabId": { "type": "integer" } } },
    { "type": "object", "required": ["type", "tabId"], "properties": { "type": { "const": "group-tab" }, "tabId": { "type": "integer" }, "title": { "type": "string" }, "color": { "type": "string" } } }
  ]
}
```

---

## Examples (`curl`)

Safe surfaces for agents: **`POST /command`**, **`POST /run-scenario`**, **`GET /status`**, **`GET /last-run`**. **Avoid `GET /next`** unless you complete **`POST /done`** (see **Internal (extension ↔ server)**).

**List tabs:**

```bash
curl -sS -X POST http://localhost:7823/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"tabs","query":{}}'
```

**Evaluate JS in a tab (after attach):**

```bash
curl -sS -X POST http://localhost:7823/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"cdp","tabId":TAB_ID,"method":"Runtime.evaluate","params":{"expression":"location.href","returnByValue":true}}'
```

**Run a Scenario Package** (`scenarioPath` = root directory of that package):

```bash
curl -sS -X POST http://localhost:7823/run-scenario \
  -H 'Content-Type: application/json' \
  -d '{"scenarioPath":"./chrome-extension/_scenarios/my-flow/20260101120000","params":{},"stopOnFail":true}'
```

**Run a Scenario Package against an existing tab** (single‑working‑tab workflow — see [§ B.1](#b1-reusing-a-tab-across-runs-singleworkingtab-workflow)):

```bash
curl -sS -X POST http://localhost:7823/run-scenario \
  -H 'Content-Type: application/json' \
  -d '{"scenarioPath":"/abs/path/to/package","tabId":12345,"params":{}}'
```

The runner attaches to tab `12345`, runs the steps, and detaches. It does **not** close the tab and does **not** alter its tab group. Make sure step 1 of the package handles whatever DOM state the previous run left behind.

Agents should use the same URLs and JSON bodies with their HTTP client of choice.
