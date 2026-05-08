#!/bin/bash
# Queue release script — builds desktop app and creates proper updater artifacts
# Usage: ./release.sh
# Requires: TAURI_SIGNING_PRIVATE_KEY env var set to the minisign private key content

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"
BUNDLE_DIR="$DESKTOP_DIR/src-tauri/target/release/bundle"
RELEASE_DIR="$REPO_ROOT/desktop/release"

# ── Read version from tauri.conf.json ─────────────────────────────────────
VERSION=$(jq -r '.version' "$DESKTOP_DIR/src-tauri/tauri.conf.json")
echo "Building Queue v$VERSION..."

# ── Build ─────────────────────────────────────────────────────────────────
cd "$DESKTOP_DIR"
cargo tauri build

# ── Locate build artifacts ────────────────────────────────────────────────
APP_BUNDLE="$BUNDLE_DIR/macos/Queue.app"
DMG_FILE="$BUNDLE_DIR/dmg/Queue_${VERSION}_x64.dmg"

if [ ! -d "$APP_BUNDLE" ]; then
  echo "ERROR: Queue.app not found at $APP_BUNDLE"
  exit 1
fi

# ── Create updater package (.app.tar.gz) ──────────────────────────────────
# Tauri macOS updater requires a tar.gz of the .app bundle, NOT the DMG
TARBALL_NAME="Queue_${VERSION}_x64.app.tar.gz"
TARBALL_PATH="$RELEASE_DIR/$TARBALL_NAME"

echo "Creating updater tarball: $TARBALL_NAME"
tar czf "$TARBALL_PATH" -C "$BUNDLE_DIR/macos" Queue.app
echo "Tarball created: $TARBALL_PATH"

# ── Sign the tarball ──────────────────────────────────────────────────────
echo "Signing tarball..."
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/queue.key) TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  "$REPO_ROOT/desktop/node_modules/.bin/tauri" signer sign "$TARBALL_PATH"
TARBALL_SIG_PATH="$TARBALL_PATH.sig"

if [ ! -f "$TARBALL_SIG_PATH" ]; then
  echo "ERROR: Signature not created at $TARBALL_SIG_PATH"
  exit 1
fi
TARBALL_SIG=$(cat "$TARBALL_SIG_PATH")
echo "Signature: $TARBALL_SIG"

# ── Copy DMG to release dir ───────────────────────────────────────────────
if [ -f "$DMG_FILE" ]; then
  cp "$DMG_FILE" "$RELEASE_DIR/"
  echo "DMG copied to $RELEASE_DIR"
fi

# ── Update latest.json ────────────────────────────────────────────────────
PUB_DATE=$(date -u +"%Y-%m-%dT00:00:00Z")
TARBALL_URL="https://github.com/smagalski/Queue-App/releases/download/v${VERSION}/${TARBALL_NAME}"

# Read release notes from constants.js APP_CHANGES array
NOTES=$(node -e "
const src = require('fs').readFileSync('$REPO_ROOT/public/js/constants.js', 'utf8');
const m = src.match(/APP_CHANGES\s*=\s*\[([\s\S]*?)\];/);
if (!m) { console.log('No changes found'); process.exit(0); }
const items = m[1].match(/'([^']+)'/g) || [];
console.log(items.map(s => s.slice(1,-1)).join('. ') + '.\n\n⚠️ This app is a work in progress and may experience errors.');
" 2>/dev/null || echo "Queue v${VERSION}\n\n⚠️ This app is a work in progress and may experience errors.")

cat > "$REPO_ROOT/latest.json" <<JSON
{
  "version": "$VERSION",
  "notes": "$NOTES",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-x86_64": {
      "signature": "$TARBALL_SIG",
      "url": "$TARBALL_URL"
    }
  }
}
JSON
echo "latest.json updated."

# ── Create GitHub release ─────────────────────────────────────────────────
echo ""
echo "Creating GitHub release v$VERSION..."
gh release create "v$VERSION" \
  "$TARBALL_PATH" \
  "$TARBALL_SIG_PATH" \
  "$RELEASE_DIR/Queue_${VERSION}_x64.dmg" \
  "$REPO_ROOT/latest.json" \
  --title "v$VERSION" \
  --notes "$NOTES" \
  --repo smagalski/Queue-App

echo ""
echo "✓ Release v$VERSION complete!"
echo "  Updater URL: $TARBALL_URL"
echo "  DMG (manual install): https://github.com/smagalski/Queue-App/releases/download/v${VERSION}/Queue_${VERSION}_x64.dmg"
