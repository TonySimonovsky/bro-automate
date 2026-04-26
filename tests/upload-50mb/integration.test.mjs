// pm/build/v.0.01/tests/upload-50mb/integration.test.mjs
// End-to-end: extension/lib/file-transfer.js (serveFile, fetchToBlob) against a
// real native-host/host.js subprocess. No Chrome.
//
// The 50 MB cap for uploadFile is enforced in extension/lib/steps/upload-file.js
// (and step contract), not in file-transfer — this module does not reject 51 MB;
// case 3 only proves serveFile still reports the true size.
//
// If the 50 MB round-trip exceeds 60 s on a slow machine, set
//   BRO_UPLOAD_INTEGRATION_BYTES=5242880
// to force a 5 MB run (see TODO: Wave 5 Gate 2 / Gate 3 for the canonical 50 MB CI check).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validate } from "../../extension/lib/schema-validator.js";
import * as fileTransfer from "../../extension/lib/file-transfer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const HOST_JS = path.join(REPO_ROOT, "native-host", "host.js");
const SCENARIO_JSON = path.join(__dirname, "test-scenario", "scenario.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "scenario.schema.json");

const FIFTY_MB = 50 * 1024 * 1024;
const FIFTY_ONE_MB = 51 * 1024 * 1024;

function parseCase1Bytes() {
  const raw = process.env.BRO_UPLOAD_INTEGRATION_BYTES;
  if (raw == null || raw === "") {
    return FIFTY_MB;
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    return FIFTY_MB;
  }
  return n;
}

// TODO (Wave 5 Gate 2 / Gate 3): when tightening CI, re-run the full 50 MB path
// without BRO_UPLOAD_INTEGRATION_BYTES on representative hardware.

/**
 * @param {object} obj
 * @returns {Buffer}
 */
function encodeNative(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function createNativeBridgeFromHost(child) {
  /** @type {Set<(msg: object) => void>} */
  const handlers = new Set();
  let buf = Buffer.alloc(0);
  function parse() {
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) {
        return;
      }
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let obj;
      try {
        obj = JSON.parse(body.toString("utf8"));
      } catch {
        /* ignore malformed */
        continue;
      }
      for (const h of handlers) {
        h(obj);
      }
    }
  }
  child.stdout.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    parse();
  });
  return {
    /**
     * @param {object} msg
     */
    send(msg) {
      child.stdin.write(encodeNative(msg));
    },
    /**
     * @param {(msg: object) => void} handler
     */
    onMessage(handler) {
      handlers.add(handler);
    },
    /**
     * @param {(msg: object) => void} handler
     */
    offMessage(handler) {
      handlers.delete(handler);
    },
  };
}

test("test-scenario/scenario.json validates against schema", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const scenario = JSON.parse(readFileSync(SCENARIO_JSON, "utf8"));
  const r = validate(schema, scenario);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test(
  "file-transfer: native host — serveFile + fetchToBlob, one-time URL, 51 MB size report",
  { timeout: 120_000 },
  async () => {
    const case1Bytes = parseCase1Bytes();

    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), "bro-u50-"));
    const logDir = path.join(tmpBase, "logs");
    const sockPath = path.join(tmpBase, "u50.sock");
    await fsp.mkdir(logDir, { recursive: true });

    const file50 = path.join(tmpBase, "payload.bin");
    const file51 = path.join(tmpBase, "over.bin");

    const child = spawn(process.execPath, [HOST_JS], {
      env: {
        ...process.env,
        BRO_HOST_LOG_DIR: logDir,
        BRO_HOST_SOCKET_PATH: sockPath,
        BRO_HOST_MAX_LOG_BYTES: "16384",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let rid = 0;
    const requestIdFactory = () => `u50-${++rid}`;

    const bridge = createNativeBridgeFromHost(child);

    let httpPort = 0;
    let token = "";

    const readyP = new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg && msg.event === "hostReady" && typeof msg.httpPort === "number" && msg.token) {
          bridge.offMessage(onMsg);
          resolve({ httpPort: msg.httpPort, token: String(msg.token) });
        }
      };
      bridge.onMessage(onMsg);
      child.on("error", reject);
    });

    const ready = await readyP;
    httpPort = ready.httpPort;
    token = ready.token;
    let expectSha256;
    let lastUrl;

    try {
      await fsp.writeFile(file50, Buffer.alloc(case1Bytes, 0x6e));

      const sf1 = await fileTransfer.serveFile(file50, { nativeBridge: bridge, requestIdFactory });
      assert.equal(sf1.size, case1Bytes);
      assert.equal(typeof sf1.url, "string");
      assert.ok(sf1.url.includes(`:${httpPort}/bro-file/`), "url should point at host file route");
      assert.match(String(sf1.sha256), /^[0-9a-f]{64}$/u);
      expectSha256 = sf1.sha256;
      lastUrl = sf1.url;

      const blob1 = await fileTransfer.fetchToBlob(sf1.url, token, case1Bytes, sf1.sha256);
      assert.equal(blob1.size, case1Bytes);

      await assert.rejects(
        () => fileTransfer.fetchToBlob(lastUrl, token, case1Bytes, String(expectSha256)),
        (err) =>
          err != null &&
          typeof err === "object" &&
          err.code === "uploadRejected" &&
          typeof err.message === "string",
      );

      await fsp.writeFile(file51, Buffer.alloc(FIFTY_ONE_MB, 0x1c));
      const sf2 = await fileTransfer.serveFile(file51, { nativeBridge: bridge, requestIdFactory });
      assert.equal(sf2.size, FIFTY_ONE_MB, "file-transfer does not cap at 50 MB; upload-file step does");
    } finally {
      child.kill("SIGTERM");
      const exitPromise = once(child, "exit");
      const raced = await Promise.race([
        exitPromise.then(([code, sig]) => ({ code, sig })),
        new Promise((_, rej) => setTimeout(() => rej(new Error("host did not exit within 2s")), 2000)),
      ]);
      assert.equal(raced.code, 0);
      assert.equal(raced.sig, null);
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    }
  },
);
