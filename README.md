# Bro Automate

Generic, agent-driven browser automation as a Chrome MV3 extension with a native-messaging
bridge. External agents send JSON commands to the extension; the extension runs **scenarios**
against real web pages in your already-authenticated Chrome and returns structured JSON results.

- **Version:** v0.01
- **Platform:** macOS + Google Chrome only
- **Spec:** product and technical specs live under `pm/build/v.0.01/` (**private dev checkout only**; this folder is not mirrored to the public repo).

---

## Repo layout

See `pm/build/v.0.01/TDD.md` §3 for the canonical layout.

```
bro-automate/code/main/
├── extension/         # Chrome MV3 extension (service worker + scenarios)
├── native-host/       # Node.js native messaging host (Unix socket + HTTP I/O)
├── cli/               # bro.js — one-shot CLI for manual testing
├── schema/            # canonical scenario.schema.json
├── tests/             # Node test suite + fixtures (mirrored to the public repo)
└── pm/build/v.0.01/   # PRD, TDD, operator docs (private dev repo only)
```

---

## Install

From the **repo root** (`bro-automate/code/main/`):

1. **Native host + schema copy** — writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/aichamp.bro.automate.json`, generates `native-host/host.installed.js` with an absolute Node shebang, and copies `schema/scenario.schema.json` → `extension/scenario.schema.json`. Does **not** touch the Upwork host manifest (`com.upwork.scraper.cco46.json`) unless paths were misconfigured (see PRD FR-N3).

   ```sh
   ./native-host/install.sh
   ```

   Re-run after changing `host.js` or when Node moves. Use `--force` only when the installer refuses due to an existing manifest or schema mtimes (see `install.sh --help`).

2. **Load the unpacked extension** in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select the `./extension` directory.

3. **Native messaging `allowed_origins`** — after the first load, open `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/aichamp.bro.automate.json` and replace `chrome-extension://<EXTENSION_ID>/` with your real extension ID from `chrome://extensions`. Re-running `install.sh` preserves a non-placeholder origin if already set.

4. **Sanity check** — open the service worker DevTools for Bro Automate; you should see a `hostReady` payload with `{ httpPort, token }`.

Details and troubleshooting: `pm/build/v.0.01/operator-walkthrough.md` in the private dev tree.

---

## Smoke tests

Full list: `pm/build/v.0.01/TDD.md` §15 (T-1 through T-11). Headline CLI commands (repo root; terminal JSON on **stdout**, progress on **stderr**):

```sh
./cli/bro.js '{"action":"runScenario","scenarioId":"upwork-collect","requestId":"r1","params":{"jobIds":["EXISTING_ID"]}}'

./cli/bro.js '{"action":"runScenario","scenarioId":"linkedin-scheduled-posts","requestId":"r2"}'
```

Node tests:

```sh
find tests -name '*.test.mjs' | sort | xargs node --test --test-force-exit
```

The same discovery pattern runs in **GitHub Actions** on every push and pull request (workflow `.github/workflows/node-tests.yml`).

---

## Documentation

- **Product:** `pm/build/v.0.01/PRD.md`
- **Technical:** `pm/build/v.0.01/TDD.md`
- **Known issues / flakes:** `pm/build/v.0.01/known-issues.md`
- **Gate 3 checklist:** `pm/build/v.0.01/operator-checklist.md`
- **LinkedIn element map (input):** `pm/build/v.0.01/inputs/scenarios/linkedin-scheduled-posts-map.md`
- **Build / waves:** `pm/build/v.0.01/waves.md`

*(Paths above exist in the private dev repository; they are not part of the public mirror.)*
