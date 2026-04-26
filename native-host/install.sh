#!/usr/bin/env bash
# native-host/install.sh — writes the Chrome native messaging host manifest for
# `aichamp.bro.automate`, copies/symlinks schema/scenario.schema.json into
# extension/scenario.schema.json (per TDD §3 build-time symlink), and refuses to overwrite an
# existing Upwork host manifest unless --force is passed (PRD FR-N3).
#
# Schema install: we use `cp -f` so the extension copy mirrors the canonical file and mtimes
# stay comparable; `ln -sf "$REPO_ROOT/schema/scenario.schema.json" "$DST"` is an acceptable
# alternative called out in TDD §3 / PRD FR-V1.
#
# TDD: §6, §16.2 (T-204), §16.3 (T-306)
# Tasks: T-204, T-306
# Wave: 2
# Status: implemented (Wave 2)
#
# Coexistence (FR-N3): this script only writes aichamp.bro.automate.json — never
# NativeMessagingHosts/com.upwork.scraper.cco46.json. If those two paths were ever
# misconfigured to be identical, mv is aborted at definition time.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE_HOST_DIR="$REPO_ROOT/native-host"
HOST_JS="$NATIVE_HOST_DIR/host.js"
# Generated copy of host.js with absolute-node-path shebang baked in. The source host.js
# stays portable (`#!/usr/bin/env node`); we never modify it. Chrome's NMH spawn env
# doesn't include nvm/Homebrew PATH additions, so /usr/bin/env can't find node — the
# generated copy uses the absolute path and sidesteps that.
INSTALLED_HOST_JS="$NATIVE_HOST_DIR/host.installed.js"
SCHEMA_SRC="$REPO_ROOT/schema/scenario.schema.json"
SCHEMA_DST="$REPO_ROOT/extension/scenario.schema.json"
CHROME_NMH_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
OUR_MANIFEST_NAME="aichamp.bro.automate.json"
UPWORK_MANIFEST_NAME="com.upwork.scraper.cco46.json"
OUR_MANIFEST_PATH="${CHROME_NMH_DIR}/${OUR_MANIFEST_NAME}"
UPWORK_MANIFEST_PATH="${CHROME_NMH_DIR}/${UPWORK_MANIFEST_NAME}"
FORCE=0

usage() {
  cat <<'EOF'
Usage: native-host/install.sh [options]

Writes the Chrome Native Messaging manifest for Bro Automate (aichamp.bro.automate)
and copies schema/scenario.schema.json into extension/scenario.schema.json.

Options:
  --force   Overwrite mismatched aichamp.bro.automate.json; allow schema sync when
            the canonical schema is older than extension/scenario.schema.json.
            This installer never writes com.upwork.scraper.cco46.json (FR-N3 coexistence).
  --help    Show this help.

After first Chrome load, edit allowed_origins in:
  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/aichamp.bro.automate.json
Replace chrome-extension://<EXTENSION_ID>/ with your real extension ID from
chrome://extensions (Developer mode → ID).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

chmod +x "$0" || true
chmod +x "$HOST_JS" || true

# Resolve node's absolute path at install time. Required because Chrome spawns the native
# messaging host with a MINIMAL environment that does NOT include nvm/Homebrew-installed
# node in PATH. Without this, `#!/usr/bin/env node` in host.js fails and Chrome reports
# the host as "not found" — see operator-walkthrough §5 troubleshooting.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  echo "error: node not found in PATH. Install Node.js (e.g. via nvm or Homebrew) and re-run." >&2
  exit 1
fi
# Resolve symlinks so the installed host always points at a stable real path (nvm shims aside).
NODE_REAL="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
if [[ ! -x "$NODE_REAL" ]]; then
  NODE_REAL="$NODE_BIN"
fi

# Generate native-host/host.installed.js — a copy of host.js with the first-line shebang
# rewritten to the absolute node path detected above. Chrome's NMH manifest points at
# this generated file; source host.js stays portable. Re-running install.sh is the only
# way to refresh the installed copy after dev edits to host.js.
{
  echo "#!$NODE_REAL"
  tail -n +2 "$HOST_JS"
} > "$INSTALLED_HOST_JS"
chmod +x "$INSTALLED_HOST_JS"

if [[ ! -f "$SCHEMA_SRC" ]]; then
  echo "error: missing canonical schema at $SCHEMA_SRC" >&2
  exit 1
fi

if [[ -f "$SCHEMA_DST" ]] && [[ "$SCHEMA_SRC" -ot "$SCHEMA_DST" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "error: $SCHEMA_SRC is older than $SCHEMA_DST; update the canonical schema or pass --force." >&2
    exit 1
  fi
  echo "warn: forcing schema copy even though canonical is older than extension copy (--force)." >&2
fi

mkdir -p "$(dirname "$SCHEMA_DST")"
cp -f "$SCHEMA_SRC" "$SCHEMA_DST"

if [[ -f "$UPWORK_MANIFEST_PATH" ]]; then
  echo "info: existing Upwork native host manifest left unchanged: $UPWORK_MANIFEST_PATH (FR-N3)." >&2
fi

mkdir -p "$CHROME_NMH_DIR"

write_manifest_to() {
  local out_path="$1"
  # The manifest's `path` points at host.installed.js, not source host.js directly, so
  # Chrome's spawn environment doesn't need to resolve node via PATH (see installed-copy
  # generation comment above).
  #
  # Preserve `allowed_origins` from the existing installed manifest if it's been edited
  # away from the `<EXTENSION_ID>` placeholder (which the operator does after first
  # extension load per operator-walkthrough §2.3). Re-running install.sh for unrelated
  # reasons (node version change, repo move, etc.) should NOT force the operator to
  # paste the extension ID again.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const installedHost = process.argv[1];
    const out = process.argv[2];
    const installedPath = process.argv[3];
    const placeholder = "chrome-extension://<EXTENSION_ID>/";
    let allowed_origins = [placeholder];
    try {
      const prev = JSON.parse(fs.readFileSync(installedPath, "utf8"));
      if (Array.isArray(prev.allowed_origins) && prev.allowed_origins.length > 0) {
        const real = prev.allowed_origins.filter(s => typeof s === "string" && s !== placeholder);
        if (real.length > 0) allowed_origins = real;
      }
    } catch (_) {
      // installed manifest does not exist or is unreadable — fall through to placeholder.
    }
    const body = {
      name: "aichamp.bro.automate",
      // `description` is REQUIRED by Chrome NMH spec — without it Chrome silently rejects
      // the manifest at lookup time and reports "Specified native messaging host not
      // found." (the same generic error as a missing manifest). See
      // https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host
      description: "Bro Automate native messaging host (PRD FR-N1)",
      path: installedHost,
      type: "stdio",
      allowed_origins
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
  ' "$INSTALLED_HOST_JS" "$out_path" "$OUR_MANIFEST_PATH"
}

if [[ "$OUR_MANIFEST_PATH" == "$UPWORK_MANIFEST_PATH" ]]; then
  echo "error: manifest path misconfigured (would overwrite Upwork host)." >&2
  exit 1
fi

TMP_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/bro-automate-manifest.XXXXXX")"
cleanup() { rm -f "$TMP_MANIFEST"; }
trap cleanup EXIT

write_manifest_to "$TMP_MANIFEST"

if [[ -f "$OUR_MANIFEST_PATH" ]] && [[ "$FORCE" -ne 1 ]] && ! cmp -s "$TMP_MANIFEST" "$OUR_MANIFEST_PATH"; then
  echo "error: $OUR_MANIFEST_PATH exists with different contents; pass --force to replace." >&2
  exit 1
fi

mv "$TMP_MANIFEST" "$OUR_MANIFEST_PATH"
trap - EXIT

echo "Installed $OUR_MANIFEST_PATH" >&2
# Detect whether the freshly written manifest still uses the placeholder; if so the
# operator still needs to do the §2.3 step. If we preserved a real extension ID from a
# prior install, say so explicitly so the operator knows they don't need to re-edit.
if grep -q '<EXTENSION_ID>' "$OUR_MANIFEST_PATH"; then
  echo "Edit allowed_origins: replace <EXTENSION_ID> with your chrome-extension ID after first load." >&2
  echo "  (See pm/build/v.0.01/operator-walkthrough.md §2.3.)" >&2
else
  echo "Preserved allowed_origins from previous install (extension ID unchanged)." >&2
fi
