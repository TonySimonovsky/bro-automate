# Bro Automate

Generic, agent-driven browser automation as a Chrome MV3 extension with a native-messaging
bridge. External agents send JSON commands to the extension; the extension runs **scenarios**
against real web pages in your already-authenticated Chrome and returns structured JSON results.

- **Version:** v0.01
- **Platform:** macOS + Google Chrome only

---

## Repo layout

```
.
├── extension/         # Chrome MV3 extension (service worker + scenarios)
├── native-host/       # Node.js native messaging host (Unix socket + HTTP I/O)
├── cli/               # bro.js — one-shot CLI for manual testing
├── schema/            # canonical scenario.schema.json
└── tests/             # Node test suite + fixtures
```

---

## Install

From the **repository root** (the folder that contains `extension/`, `native-host/`, and `cli/`):

1. **Native host + schema copy** — writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/aichamp.bro.automate.json`, generates `native-host/host.installed.js` with an absolute Node shebang, and copies `schema/scenario.schema.json` → `extension/scenario.schema.json`. Does **not** touch unrelated Chrome native-messaging manifests unless paths were misconfigured.

   ```sh
   ./native-host/install.sh
   ```

   Re-run after changing `host.js` or when Node moves. Use `--force` only when the installer refuses due to an existing manifest or schema mtimes (see `install.sh --help`).

2. **Load the unpacked extension** in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select the `./extension` directory.

3. **Native messaging `allowed_origins`** — after the first load, open `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/aichamp.bro.automate.json` and replace `chrome-extension://<EXTENSION_ID>/` with your real extension ID from `chrome://extensions`. Re-running `install.sh` preserves a non-placeholder origin if already set.

4. **Sanity check** — open the service worker DevTools for Bro Automate; you should see a `hostReady` payload with `{ httpPort, token }`.

---

## Smoke tests

Example CLI commands (repo root; terminal JSON on **stdout**, progress on **stderr**):

```sh
./cli/bro.js '{"action":"runScenario","scenarioId":"upwork-collect","requestId":"r1","params":{"jobIds":["EXISTING_ID"]}}'

./cli/bro.js '{"action":"runScenario","scenarioId":"linkedin-scheduled-posts","requestId":"r2"}'
```

Node tests:

```sh
find tests -name '*.test.mjs' | sort | xargs node --test --test-force-exit
```

The same discovery pattern runs in **GitHub Actions** on every push and pull request (workflow `.github/workflows/node-tests.yml`).

