# Local smoke scenario (deterministic Chrome pipeline)

Purpose: prove the Bro Automate browser pipeline works in real Chrome without relying on LinkedIn or Upwork selectors.

This scenario exercises:

1. `navigate` to a local HTTP page
2. `waitForSelector` (`#ready`)
3. `click` (`#increment`)
4. `waitForText` (`count: 1`)
5. `extract` (`#status`, `#count`)

## Run

From repo root, terminal 1:

```bash
node tests/local-smoke/server.mjs --port 8766
```

Reload Bro Automate in `chrome://extensions` so the newly bundled `local-smoke` scenario is loaded.

From repo root, terminal 2:

```bash
./cli/bro.js '{"action":"runScenario","scenarioId":"local-smoke","requestId":"local-smoke-1"}'
```

Expected terminal response:

```json
{"requestId":"local-smoke-1","runId":"...","ok":true,"action":"runScenarioResult","data":[{"status":"clicked","count":"count: 1"}]}
```

If this fails, fix the browser/runner/transport pipeline before running LinkedIn or Upwork again.

The local server is only required for `local-smoke`; it is not used by LinkedIn or Upwork. For live-site debugging, prefer:

```bash
BRO_CLI_LOG=1 ./cli/bro.js '{"action":"runScenario","scenarioId":"linkedin-scheduled-posts","requestId":"linkedin-debug-1"}'
```

This keeps the terminal compact and writes the full progress/debug stream to `pm/build/v.0.01/logs/cli/`.
