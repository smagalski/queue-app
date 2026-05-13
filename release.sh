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
TAURI_BIN="$DESKTOP_DIR/node_modules/.bin/tauri"
if [ ! -f "$TAURI_BIN" ]; then
  echo "Installing Tauri CLI dependencies..."
  cd "$DESKTOP_DIR" && npm install
fi
cd "$DESKTOP_DIR"
"$TAURI_BIN" build

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

# ── Build custom DMG with installer script (bypasses Gatekeeper quarantine) ──
CUSTOM_DMG="$RELEASE_DIR/Queue_${VERSION}_x64.dmg"
DMG_STAGING="$RELEASE_DIR/dmg_staging"

rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"

# Copy app bundle into staging
cp -R "$APP_BUNDLE" "$DMG_STAGING/Queue.app"

# Create installer script that strips quarantine after copying to /Applications
cat > "$DMG_STAGING/Install Queue.command" << 'INSTALL_EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$SCRIPT_DIR/Queue.app"
APP_DEST="/Applications/Queue.app"
echo "Installing Queue to /Applications..."
[ -d "$APP_DEST" ] && rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"
xattr -cr "$APP_DEST"
echo "Done! Launching Queue..."
open "$APP_DEST"
INSTALL_EOF
chmod +x "$DMG_STAGING/Install Queue.command"

# Add a plain-text readme so users know to run the installer, not drag the app
cat > "$DMG_STAGING/HOW TO INSTALL.txt" << 'README_EOF'
How to install Queue
────────────────────
1. Double-click "Install Queue.command" in this window.
2. macOS will ask if you want to open it — click Open.
3. Queue will be copied to /Applications and launched automatically.

Why not just drag the app?
──────────────────────────
Queue is not yet signed with an Apple Developer certificate. Dragging
Queue.app directly to Applications triggers a Gatekeeper warning ("Apple
could not verify..."). The installer script handles this automatically by
clearing the quarantine flag after copying.
README_EOF

# Pack into a compressed DMG
hdiutil create \
  -volname "Queue $VERSION" \
  -srcfolder "$DMG_STAGING" \
  -ov \
  -format UDZO \
  "$CUSTOM_DMG"

rm -rf "$DMG_STAGING"
echo "Custom DMG created: $CUSTOM_DMG"

# ── Update latest.json ────────────────────────────────────────────────────
PUB_DATE=$(date -u +"%Y-%m-%dT00:00:00Z")
TARBALL_URL="https://github.com/smagalski/Queue-App/releases/download/v${VERSION}/${TARBALL_NAME}"

# Build latest.json via Node so JSON.stringify handles all escaping (newlines, quotes, etc.)
node -e "
const fs = require('fs');
const src = fs.readFileSync('$REPO_ROOT/public/js/constants.js', 'utf8');
const m = src.match(/APP_CHANGES\s*=\s*\[([\s\S]*?)\];/);
const items = m ? (m[1].match(/'([^']+)'/g) || []).map(s => s.slice(1,-1)) : [];
const notes = (items.length ? items.join('\n') : 'Queue v$VERSION') +
  '\n\n⚠️ This app is a work in progress and may experience errors.';
const obj = {
  version: '$VERSION',
  notes,
  pub_date: '$PUB_DATE',
  platforms: {
    'darwin-x86_64': {
      signature: '$TARBALL_SIG',
      url: '$TARBALL_URL',
    }
  }
};
fs.writeFileSync('$REPO_ROOT/latest.json', JSON.stringify(obj, null, 2) + '\n');
"
echo "latest.json updated."

# ── Extract release notes from latest.json for the GitHub release page ───────
NOTES=$(node -e "
const obj = JSON.parse(require('fs').readFileSync('$REPO_ROOT/latest.json','utf8'));
process.stdout.write(obj.notes);
")

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
