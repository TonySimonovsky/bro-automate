// file-transfer.js — HTTP-localhost client for binary I/O (PRD §5.7; TDD §8).
// serveFile routes via native bridge; fetch(url) with X-Bro-Token; sha256 verify;
// MAIN-world DataTransfer injection for uploadFile.
// TDD: §8 (file upload transport), §13 (token auth), §14 (50 MB budget — cap enforced by step-runner)
// Tasks: T-600, T-601, T-602, T-603
// Wave: 2
// Status: implemented (Wave 2)

/** @typedef {{ send: (msg: object) => void, onMessage: (handler: (msg: object) => void) => void }} NativeBridge */

export let MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * @param {number} n
 */
export function setMaxUploadBytes(n) {
  MAX_UPLOAD_BYTES = n;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Normalize a wire-format sha256 (64-char lowercase hex or base64) for comparison.
 * @param {string} digestHex Lowercase hex from Web Crypto
 * @param {string} expected From host (hex or base64)
 */
function sha256Matches(digestHex, expected) {
  const exp = String(expected).trim();
  if (/^[0-9a-fA-F]{64}$/.test(exp)) {
    return digestHex === exp.toLowerCase();
  }
  // Assume base64 (or base64url) — compare decoded bytes
  try {
    const normalizedB64 = exp.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalizedB64.length % 4;
    const padded =
      pad === 0 ? normalizedB64 : normalizedB64 + "=".repeat(4 - pad);
    const decoded = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const expectedHex = arrayBufferToHex(decoded.buffer);
    return expectedHex.length === 64 && expectedHex === digestHex;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @param {{ nativeBridge: NativeBridge, requestIdFactory: () => string }} opts
 * @returns {Promise<{ url: string, size: number, mime: string, sha256: string }>}
 */
export function serveFile(filePath, { nativeBridge, requestIdFactory }) {
  const requestId = requestIdFactory();
  let settled = false;
  return new Promise((resolve, reject) => {
    function finish() {
      if (settled) return;
      settled = true;
      if (typeof nativeBridge.offMessage === "function") {
        nativeBridge.offMessage(handler);
      }
    }

    /** @param {object} msg */
    function handler(msg) {
      if (settled || msg == null || typeof msg !== "object") {
        return;
      }
      if (msg.requestId !== requestId) {
        return;
      }
      if (msg.ok === true && msg.data && typeof msg.data === "object") {
        const { url, size, mime, sha256 } = msg.data;
        if (
          typeof url === "string" &&
          typeof size === "number" &&
          typeof mime === "string" &&
          typeof sha256 === "string"
        ) {
          finish();
          resolve({ url, size, mime, sha256 });
          return;
        }
        finish();
        reject({
          code: "internal",
          message: "serveFile response missing url, size, mime, or sha256",
        });
        return;
      }
      const code =
        typeof msg.error === "string" && msg.error.length > 0
          ? msg.error
          : "internal";
      const message =
        typeof msg.errorMessage === "string"
          ? msg.errorMessage
          : "serveFile failed";
      finish();
      reject({ code, message });
    }

    nativeBridge.onMessage(handler);
    nativeBridge.send({ action: "serveFile", filePath, requestId });
  });
}

/**
 * @param {string} url
 * @param {string} token Session X-Bro-Token (PRD FR-B3)
 * @param {number} expectedSize
 * @param {string} expectedSha256 Host-reported digest (hex or base64)
 * @returns {Promise<Blob>}
 */
export async function fetchToBlob(url, token, expectedSize, expectedSha256) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "X-Bro-Token": token },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw { code: "internal", message: `fetch failed: ${message}` };
  }

  if (!res.ok) {
    const message = `HTTP ${res.status} fetching file bytes`;
    throw { code: "uploadRejected", message };
  }

  const blob = await res.blob();
  if (blob.size !== expectedSize) {
    throw {
      code: "internal",
      message: `size mismatch: got ${blob.size}, expected ${expectedSize}`,
    };
  }

  const ab = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", ab);
  const digestHex = arrayBufferToHex(digest);
  if (!sha256Matches(digestHex, expectedSha256)) {
    throw {
      code: "internal",
      message: "sha256 mismatch after fetch",
    };
  }

  return new Blob([ab], { type: blob.type || "application/octet-stream" });
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * MAIN-world file injection (TDD §8 step 5).
 * @param {number} tabId
 * @param {string} selector
 * @param {string} base64
 * @param {string} fileName
 * @param {string} mime
 * @returns {Promise<void>}
 */
export async function injectFileIntoInput(
  tabId,
  selector,
  base64,
  fileName,
  mime
) {
  if (typeof chrome === "undefined") {
    throw {
      code: "internal",
      message:
        "injectFileIntoInput requires Chrome extension APIs (chrome is undefined)",
    };
  }
  if (typeof chrome.scripting === "undefined") {
    throw {
      code: "internal",
      message:
        "injectFileIntoInput requires chrome.scripting (extension API not available)",
    };
  }

  /** @type {{ ok: true } | { ok: false, reason: string }} */
  const injectFn = (sel, b64, name, type) => {
    const input = document.querySelector(sel);
    if (!input) {
      return { ok: false, reason: "inputMissing" };
    }
    if (input.disabled) {
      return { ok: false, reason: "inputDisabled" };
    }
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    } catch {
      return { ok: false, reason: "rejectedByPage" };
    }
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: injectFn,
    args: [selector, base64, fileName, mime],
  });

  const first = results && results[0];
  const r = first && first.result;
  if (!r || typeof r !== "object") {
    throw {
      code: "internal",
      message: "injectFileIntoInput: no result from executeScript",
    };
  }
  if (r.ok === true) {
    return;
  }
  if (r.ok === false) {
    const reason =
      r.reason === "inputMissing" ||
      r.reason === "inputDisabled" ||
      r.reason === "rejectedByPage"
        ? r.reason
        : "rejectedByPage";
    throw {
      code: "uploadRejected",
      reason,
      message: `file input rejected: ${reason}`,
    };
  }
  throw {
    code: "internal",
    message: "injectFileIntoInput: unexpected page result",
  };
}
