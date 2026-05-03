# Bro Automate — scenario runner reference

**Purpose:** Run multi-step browser automation by posting a **Scenario Package** (a directory of step scripts) to a local HTTP bridge. The bridge executes each step via Chrome DevTools Protocol through a Manifest V3 extension.

**Base URL:** `http://localhost:7823`

---

## Starting the bridge

Check: `curl -sS http://localhost:7823/status` — should return `{ "inFlight": false, ... }`.

If it fails, start from the repository root (Node.js, no extra dependencies):

```bash
node extension/server.js
```

If the bridge is up but commands never complete (POST /run-scenario blocks until 300s timeout), the extension is not loaded in Chrome. **Ask the user to:** open `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` directory. Once loaded it connects automatically.

---

## POST /run-scenario

**Body (JSON):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scenarioPath` | string | yes | — | Absolute or relative path to the Scenario Package root directory. Relative paths resolve from the Node process CWD. |
| `params` | object | no | `{}` | Forwarded verbatim into every step script. Before calling, read `input.json` at the package root (if present) to discover required and optional keys — see [Discovering params](#discovering-params). |
| `stopOnFail` | boolean | no | `true` | Stop after the first failing execute or verify phase. |
| `tabId` | integer | no | — | Reuse an existing tab (see [Reusing a tab](#reusing-a-tab)). Omit to let the runner create and manage a dedicated tab. |

**Response:** HTTP 200 + run result JSON (see [Run result](#run-result)).

**Lifecycle (no `tabId`):** runner creates a tab, groups it (title = last two path segments of `scenarioPath`), runs all steps, detaches, closes tab on success, leaves it open on failure.

**Lifecycle (`tabId` supplied):**

| Phase | Behavior |
|-------|----------|
| Setup | Validates tab exists. HTTP 500 if not — no silent fallback. Skips create-tab and group-tab. |
| Steps | `attach` → run steps → `detach`. |
| Teardown | `detach` always. **Never** closes the tab. Group is unchanged. |

**Side effects:** writes `<scenarioPath>/tmp/rpa-run-<timestamp>.log.json` (directory created automatically).

### Discovering params

Before calling `/run-scenario`, check for `input.json` at the package root. The bridge never reads it — it exists solely to tell agents what to pass in `params`:

```json
{
  "required": ["startUrl"],
  "optional": ["maxWaitMs"],
  "descriptions": {
    "startUrl": "Initial navigation target.",
    "maxWaitMs": "Optional wait cap; scripts define their own default."
  }
}
```

If the file is absent, `params` can be `{}`.

**Errors:** HTTP 400 if `scenarioPath` missing; HTTP 500 on runner failure (tab not found, debugger attach failed, script error).

**Never call `/run-scenario` concurrently.** A second call while one is in-flight is not rejected but overwrites shared bridge state and produces undefined behavior.

---

## GET /status · GET /status?tail=N

Poll this to track a running scenario. Default tail: last 20 events (max 50).

**Idle:**

```json
{
  "inFlight": false,
  "lastRunSuccess": true,
  "lastRunLogFile": "/abs/path/to/scenario-root/tmp/rpa-run-2026-05-01T12-00-00-000Z.log.json",
  "recentEvents": ["[rpa-cdp-v002 2026-05-01T12:05:00.000Z] ■ run finished success=true ..."]
}
```

`lastRunSuccess` and `lastRunLogFile` are `null` if no run has completed since bridge start.

**In-flight:**

```json
{
  "inFlight": true,
  "startedAt": "2026-05-01T12:00:00.000Z",
  "scenarioPath": "/abs/path/to/scenario-root",
  "tabId": 123456789,
  "currentStep": 2,
  "currentPhase": "execute",
  "stepsDone": 1,
  "totalStepsKnown": 3,
  "currentCommand": {
    "_cmdId": 42,
    "type": "cdp",
    "method": "Runtime.evaluate",
    "tabId": 123456789,
    "sentAt": 1746100800123,
    "ageMs": 450
  },
  "logFile": "/abs/path/to/scenario-root/tmp/rpa-run-2026-05-01T12-00-00-000Z.log.json",
  "recentEvents": ["[rpa-cdp-v002 2026-05-01T12:00:01.000Z] → send #42 cdp Runtime.evaluate tab=123456789 ..."]
}
```

`currentCommand` is `null` between steps/phases. `recentEvents` entries are strings: `[rpa-cdp-v002 <ISO8601>] <message>`.

**Polling pattern:** poll until `inFlight` is `false`, then call `GET /last-run` for the full result.

---

## GET /last-run

Returns the last completed run result JSON, or `null` if none since bridge start.

---

## Run result

Shape returned by `POST /run-scenario` and `GET /last-run`.

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
  "logFile": "/absolute/path/to/scenario-package-root/tmp/rpa-run-2026-05-01T12-00-00-000Z.log.json"
}
```

`tabOwned: false` when the caller supplied `tabId` — the runner never closes that tab regardless of outcome. Failing steps set `aborted` and `execute`/`verify` with an `error` field.

**Log file:** `<scenarioPath>/tmp/rpa-run-<timestamp>.log.json` — same shape as the run result above, written incrementally. Intermediate reads may show `null` for `finishedAt` and `success`.

---

## Reusing a tab

Pass `tabId` on every `/run-scenario` call to keep all runs inside a single tab and group.

**Bootstrap (first call of a session):** create the tab and group via atomic `POST /command` calls before the first `/run-scenario`:

```bash
# Create working tab
curl -sS -X POST http://localhost:7823/command -H 'Content-Type: application/json' \
  -d '{"type":"create-tab","url":"about:blank"}'
# → { "success": true, "tabId": 12345, ... }

# Group it
curl -sS -X POST http://localhost:7823/command -H 'Content-Type: application/json' \
  -d '{"type":"group-tab","tabId":12345,"title":"my-flow","color":"blue"}'
```

Then pass `"tabId": 12345` on every subsequent `/run-scenario`. At end of session, optionally close with `{"type":"close-tab","tabId":12345}`.

**Debugger contention:** if attach fails with `"Another debugger is already attached"`, issue `{"type":"detach","tabId":...}` via `POST /command` once, then retry.

**When not to use `tabId`:** one-off runs, or any case where leftover tab state is unsafe. Plain `/run-scenario` without `tabId` creates and manages its own tab.

---

## If the bridge appears hung

`POST /run-scenario` blocks for a long time and `GET /status` shows a `currentCommand` that never advances: the extension's offscreen document has a built-in watchdog that calls `chrome.runtime.reload()` after three failed SW pings (~15 s) and resumes automatically in ~1–2 s.

If it does not self-recover: **ask the user to** reload the extension at `chrome://extensions`. If the Node bridge itself is stuck, restart `server.js`.

---

## curl example

```bash
curl -sS -X POST http://localhost:7823/run-scenario \
  -H 'Content-Type: application/json' \
  -d '{"scenarioPath":"/abs/path/to/scenario-package","params":{},"stopOnFail":true}'
```
