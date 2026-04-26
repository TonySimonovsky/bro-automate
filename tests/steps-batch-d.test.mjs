/**
 * Wave 3 — uploadFile step (T-512). Mocks ctx.fileTransfer; no real native host.
 */

import assert from "node:assert/strict";
import test from "node:test";

import runUpload from "../extension/lib/steps/upload-file.js";

const NEVER = new Promise(() => {});

/**
 * @param {object} [overrides]
 */
function baseCtx(overrides = {}) {
  return {
    runId: "r_test",
    tabId: 1,
    cancelToken: new Promise(() => {}),
    hostToken: "session-token",
    nativeBridge: {
      send() {},
      onMessage() {},
    },
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 0,
        mime: "application/octet-stream",
        sha256: "00",
      }),
      fetchToBlob: async () => new Blob(),
      blobToBase64: async () => "",
      injectFileIntoInput: async () => {},
    },
    ...overrides,
  };
}

test("happy path — full result shape", async () => {
  const blob = new Blob([Buffer.from("x")]);
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 1000,
        mime: "application/pdf",
        sha256: "abc",
      }),
      fetchToBlob: async () => blob,
      blobToBase64: async () => "AAAA",
      injectFileIntoInput: async () => {},
    },
  });
  const step = {
    type: "uploadFile",
    selector: "input[type=file]",
    filePath: "/tmp/foo.pdf",
    fileName: "foo.pdf",
  };
  const out = await runUpload(ctx, step, {});
  assert.deepEqual(out, {
    uploaded: true,
    fileName: "foo.pdf",
    mime: "application/pdf",
    size: 1000,
    sha256: "abc",
    intoSelector: "input[type=file]",
  });
});

test("fileName defaults to basename of filePath", async () => {
  const blob = new Blob([]);
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 1,
        mime: "application/pdf",
        sha256: "ab",
      }),
      fetchToBlob: async () => blob,
      blobToBase64: async () => "AA",
      injectFileIntoInput: async () => {},
    },
  });
  const step = {
    type: "uploadFile",
    selector: "#f",
    filePath: "/tmp/some/resume.pdf",
  };
  const out = await runUpload(ctx, step, {});
  assert.equal(out.fileName, "resume.pdf");
});

test("size > MAX_UPLOAD_BYTES → uploadTooLarge", async () => {
  const huge = 100 * 1024 * 1024;
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/big",
        size: huge,
        mime: "application/octet-stream",
        sha256: "x",
      }),
      fetchToBlob: async () => {
        throw new Error("fetchToBlob should not run");
      },
      blobToBase64: async () => "",
      injectFileIntoInput: async () => {},
    },
  });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/big.bin" };
  await assert.rejects(
    () => runUpload(ctx, step, {}),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "uploadTooLarge" &&
      err.size === huge &&
      err.max === 50 * 1024 * 1024,
  );
});

test("uploadRejected from injectFileIntoInput propagates", async () => {
  const blob = new Blob([]);
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 2,
        mime: "text/plain",
        sha256: "ab",
      }),
      fetchToBlob: async () => blob,
      blobToBase64: async () => "AA",
      injectFileIntoInput: async () => {
        throw {
          code: "uploadRejected",
          reason: "inputDisabled",
          message: "file input rejected: inputDisabled",
        };
      },
    },
  });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/a.txt" };
  await assert.rejects(
    () => runUpload(ctx, step, {}),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "uploadRejected" &&
      err.reason === "inputDisabled",
  );
});

test("fetchToBlob HTTP 401 → uploadRejected propagates", async () => {
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 1,
        mime: "application/octet-stream",
        sha256: "a",
      }),
      fetchToBlob: async () => {
        throw { code: "uploadRejected", message: "HTTP 401" };
      },
      blobToBase64: async () => "",
      injectFileIntoInput: async () => {},
    },
  });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/x" };
  await assert.rejects(
    () => runUpload(ctx, step, {}),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "uploadRejected" &&
      err.message === "HTTP 401",
  );
});

test("fetchToBlob sha256 mismatch → internal propagates", async () => {
  const ctx = baseCtx({
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 1,
        mime: "application/octet-stream",
        sha256: "a",
      }),
      fetchToBlob: async () => {
        throw { code: "internal", message: "sha256 mismatch" };
      },
      blobToBase64: async () => "",
      injectFileIntoInput: async () => {},
    },
  });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/x" };
  await assert.rejects(
    () => runUpload(ctx, step, {}),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "internal" &&
      err.message === "sha256 mismatch",
  );
});

test("tab missing (tabId null) → internal", async () => {
  const ctx = baseCtx({ tabId: null });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/x" };
  await assert.rejects(
    () => runUpload(ctx, step, {}),
    (err) =>
      err && typeof err === "object" && err.code === "internal",
  );
});

test("cancel mid-flight during fetchToBlob → cancelled", async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });

  let resolveFetchEntered;
  const fetchEntered = new Promise((r) => {
    resolveFetchEntered = r;
  });

  const ctx = baseCtx({
    cancelToken,
    fileTransfer: {
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      serveFile: async () => ({
        url: "http://127.0.0.1/f",
        size: 10,
        mime: "application/octet-stream",
        sha256: "deadbeef",
      }),
      fetchToBlob: async () => {
        resolveFetchEntered();
        await NEVER;
        return new Blob();
      },
      blobToBase64: async () => "bad",
      injectFileIntoInput: async () => {},
    },
  });
  const step = { type: "uploadFile", selector: "#f", filePath: "/tmp/a" };

  const runP = runUpload(ctx, step, {});
  await fetchEntered;
  resolveCancel({ cancelled: true });

  await assert.rejects(
    runP,
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "cancelled" &&
      err.message === "cancelled during upload",
  );
});
