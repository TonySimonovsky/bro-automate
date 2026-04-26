// steps/upload-file.js — upload a local file by absolute path to an <input type="file"> via the
// HTTP-localhost binary I/O transport (PRD §5.5, §5.7; TDD §8). Uses lib/file-transfer.js;
// injects via DataTransfer in MAIN world. Enforces 50 MB cap.
// Errors: uploadRejected (reason: inputMissing|inputDisabled|rejectedByPage), uploadTooLarge,
//         matchesRefused, tabClosedDuringStep, internal.
// TDD: §8, §10
// Tasks: T-512
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {string} filePath
 */
function basenameFromPath(filePath) {
  const parts = String(filePath).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(filePath);
}

/**
 * @param {object} ctx
 * @returns {{ send: (msg: object) => void, onMessage: (handler: (msg: object) => void) => void, offMessage?: (handler: (msg: object) => void) => void }}
 */
function resolveNativeBridge(ctx) {
  const nb = ctx.nativeBridge;
  if (
    nb &&
    typeof nb.send === "function" &&
    typeof nb.onMessage === "function"
  ) {
    return nb;
  }
  if (
    typeof ctx.bridgeSend === "function" &&
    typeof ctx.bridgeOnMessage === "function"
  ) {
    return {
      send: ctx.bridgeSend,
      onMessage: ctx.bridgeOnMessage,
      offMessage:
        typeof ctx.bridgeOffMessage === "function"
          ? ctx.bridgeOffMessage
          : undefined,
    };
  }
  throw {
    code: "internal",
    message:
      "uploadFile requires nativeBridge on ctx (nativeBridge or bridgeSend/bridgeOnMessage)",
  };
}

/**
 * @returns {string}
 */
function newUploadRequestId(runId) {
  const suffix =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  return `${runId}_upload_${suffix}`;
}

/**
 * @template T
 * @param {Promise<{ cancelled?: true }>} cancelToken
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function raceWithCancel(cancelToken, promise) {
  return Promise.race([
    promise,
    cancelToken.then(() => {
      throw { code: "cancelled", message: "cancelled during upload" };
    }),
  ]);
}

/**
 * @template T
 * @param {number} ms
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function withDeadline(ms, promise) {
  let id;
  const timeoutP = new Promise((_, reject) => {
    id = setTimeout(() => {
      reject({
        code: "internal",
        message: `uploadFile exceeded ${ms}ms`,
      });
    }, ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(id));
}

/**
 * @param {object} ctx
 * @param {{ type: 'uploadFile', selector: string, filePath: string, fileName?: string, mime?: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  const timeoutMs = step.timeoutMs ?? 60000;
  return withDeadline(timeoutMs, runInner(ctx, step));
}

/**
 * @param {object} ctx
 * @param {{ type: 'uploadFile', selector: string, filePath: string, fileName?: string, mime?: string }} step
 */
async function runInner(ctx, step) {
  if (ctx.tabId == null) {
    throw { code: "internal", message: "uploadFile requires a tab" };
  }

  const ft = ctx.fileTransfer;
  if (!ft || typeof ft.serveFile !== "function") {
    throw {
      code: "internal",
      message: "uploadFile requires ctx.fileTransfer with serveFile",
    };
  }

  let hostToken = ctx.hostToken;
  if ((hostToken == null || hostToken === "") && globalThis.chrome?.storage?.session) {
    const c = globalThis.chrome;
    const deadline = Date.now() + 5000;
    do {
      const got = await new Promise(
        (/** @param {object | void} o */ res) => {
          try {
            c.storage.session.get(['broHttpToken'], (o) => res(o && typeof o === 'object' ? o : {}));
          } catch {
            res({});
          }
        },
      );
      if (got && got.broHttpToken != null && got.broHttpToken !== "") {
        hostToken = String(got.broHttpToken);
        break;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    } while (true);
  }
  if (hostToken == null || hostToken === "") {
    throw {
      code: "internal",
      message:
        "uploadFile requires ctx.hostToken (X-Bro-Token from hostReady)",
    };
  }

  const maxBytes = ft.MAX_UPLOAD_BYTES;
  if (typeof maxBytes !== "number") {
    throw {
      code: "internal",
      message: "uploadFile requires ctx.fileTransfer.MAX_UPLOAD_BYTES",
    };
  }

  const nativeBridge = resolveNativeBridge(ctx);

  const served = await raceWithCancel(
    ctx.cancelToken,
    ft.serveFile(step.filePath, {
      nativeBridge,
      requestIdFactory: () => newUploadRequestId(ctx.runId),
    }),
  );

  if (served.size > maxBytes) {
    throw {
      code: "uploadTooLarge",
      message: `file ${served.size} bytes exceeds cap ${maxBytes}`,
      size: served.size,
      max: maxBytes,
      filePath: step.filePath,
    };
  }

  const fileName = step.fileName ?? basenameFromPath(step.filePath);
  const mime = step.mime ?? served.mime;

  const blob = await raceWithCancel(
    ctx.cancelToken,
    ft.fetchToBlob(served.url, hostToken, served.size, served.sha256),
  );

  const base64 = await raceWithCancel(ctx.cancelToken, ft.blobToBase64(blob));

  await raceWithCancel(
    ctx.cancelToken,
    ft.injectFileIntoInput(
      ctx.tabId,
      step.selector,
      base64,
      fileName,
      mime,
    ),
  );

  return {
    uploaded: true,
    fileName,
    mime,
    size: served.size,
    sha256: served.sha256,
    intoSelector: step.selector,
  };
}
