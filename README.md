# Bro Automate

Generic, agent-driven browser automation as a Chrome MV3 extension with a local HTTP bridge.
External agents send JSON commands to the bridge; the extension executes them against real web
pages in your already-authenticated Chrome and returns structured JSON results.

- **Version:** 0.0.3
- **Platform:** macOS + Google Chrome only

---

## Repo layout

```
.
└── extension/         # Chrome MV3 extension + Node HTTP bridge (server.js)
```

---

## Install

1. **Load the unpacked extension** in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select the `./extension` directory.

2. **Start the bridge** from the repository root:

   ```sh
   node extension/server.js
   ```

   The bridge listens on `http://localhost:7823`. The extension connects automatically on load.

3. **Sanity check:**

   ```sh
   curl -sS http://localhost:7823/status
   ```

   Should return JSON immediately. If it does, agents can start sending commands.

---

## Smoke tests

With the bridge running and extension loaded, list open tabs:

```sh
curl -sS -X POST http://localhost:7823/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"tabs","query":{}}'
```

See `extension/README.md` for the full HTTP API reference.

