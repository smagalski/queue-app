# Queue App — Claude Project Instructions

## What This Is

Queue is a personal task/time-management app. It has two surfaces:
- **Web app** (`public/`) — runs in a browser, hosted via Firebase Hosting (or opened directly as a file)
- **Desktop app** (`desktop/`) — Tauri v2 wrapper around the same web app, for macOS

The web app is the source of truth. Tauri just shells it. Both use the same `public/` directory.

---

## Repository Layout

```
queue-app/
├── public/               # The entire web app (JS modules + CSS + HTML)
│   ├── index.html        # Desktop/web entry point
│   ├── mobile.html       # Mobile entry point
│   ├── overlay.html      # Tauri always-on-top overlay window
│   ├── css/
│   │   └── app.css       # All styles (single file, scoped inside :root body or media queries)
│   └── js/
│       ├── main.js       # Entry point — imports everything, exposes window.*, wires hooks
│       ├── state.js      # Single shared mutable state object (no framework)
│       ├── constants.js  # APP_VERSION, APP_DEPLOYED, APP_CHANGES, colors, labels, Firebase config
│       ├── firebase.js   # Auth, settings UI, gear menu, sync toggle, account panel
│       ├── persistence.js# save() / load() — localStorage cache + optional Firestore sync
│       ├── render.js     # Main task list render
│       ├── endday.js     # End Day modal, Day Off, Day History overlay, history gap filling
│       ├── streak.js     # Streak computation and widget render
│       ├── wrapup.js     # Wrap-up wizard (multi-step previous-day resolution)
│       ├── categories.js # Category manager, stress score settings, category tally
│       ├── taskactions.js# Add / edit / complete / delete / undo task actions
│       ├── breaks.js     # Break timer feature
│       ├── calendar.js   # Scheduled task calendar view
│       ├── gcal.js       # Google Calendar import
│       ├── mobile.js     # Mobile layout / panel switching
│       ├── sidequest.js  # Side quest / sub-task feature
│       └── utils.js      # Pure helpers (date, time, formatting, esc())
├── desktop/
│   └── src-tauri/
│       ├── tauri.conf.json  # App name, version, updater pubkey, window config
│       ├── Cargo.toml       # Rust deps (tauri v2, tauri-plugin-updater, tauri-plugin-dialog)
│       └── src/
│           └── lib.rs       # All Tauri commands: get_version, start_oauth_server,
│                            #   open_in_browser, show/hide/move overlay, manual_check_for_updates
├── latest.json           # Tauri auto-updater manifest (served via GitHub Releases CDN)
├── release.sh            # Full release script (build → sign → GitHub release)
└── CLAUDE.md             # This file
```

---

## Module Architecture

**No framework.** Pure ES modules. `main.js` imports everything and attaches functions to `window.*` so inline `onclick=` handlers in HTML can call them.

**State** lives in `state.js` as a single exported object. All modules import it and mutate it directly.

**Circular dependency avoidance**: `persistence.js` cannot import `render.js` or `endday.js` directly. Instead, `main.js` calls `registerPersistenceHooks({ render, updateTodayHistory, ... })` after importing both, injecting the callbacks.

**Key flow on sign-in:**
1. `firebase.js` `initAuth()` sets up `auth.onAuthStateChanged`
2. On user → `_enterApp(user)`: sets `state.currentUser`, reads `q_sync_off_${uid}` to restore `state.syncEnabled`, calls `load()`
3. `load()` in `persistence.js`: reads localStorage cache, renders immediately, then (if `syncEnabled`) starts Firestore `onSnapshot` listener
4. Snapshot updates push fresh data into state and re-render

**Auth is always required.** There is no anonymous / local-only mode. The "Sync off" toggle (`state.syncEnabled`) still requires sign-in — it just skips Firestore reads/writes and uses per-uid localStorage instead.

---

## Persistence & Sync

`save()` always writes to `localStorage` keyed by `q_tasks_${uid}` / `q_done_${uid}` (fast restore + offline fallback). If `state.syncEnabled && state.stateDoc`, it also writes to Firestore.

`load()` reads localStorage immediately (instant render), then establishes a Firestore `onSnapshot` if sync is enabled. The snapshot is the live source of truth.

`state.syncEnabled` is persisted as `q_sync_off_${uid}` in localStorage (absent = on, `'1'` = off).

Sync status dot/label IDs: `syncDot`, `syncLabel`. Valid status strings: `synced`, `syncing`, `error`, `offline`, `connecting`, `off`.

---

## Version Bumping (do all four, always together)

1. `public/js/constants.js` — `APP_VERSION`, `APP_DEPLOYED`, `APP_CHANGES[]`
2. `desktop/src-tauri/tauri.conf.json` — `"version"`
3. `desktop/src-tauri/Cargo.toml` — `version` field (keep in sync, though Tauri reads conf.json)
4. `latest.json` is updated automatically by `release.sh` — do not edit by hand

---

## Releasing a New Version (macOS desktop)

### Prerequisites
- Tauri signing key at `~/.tauri/queue.key` (minisign private key, base64 content)
- `~/.tauri/queue.key.pub` — public key (also embedded in `tauri.conf.json` as `plugins.updater.pubkey`)
- `gh` CLI authenticated to `smagalski/Queue-App` (public repo)
- `cargo` + `cargo-tauri` installed

### Steps

```bash
cd /path/to/queue-app
./release.sh
```

`release.sh` does everything:
1. Reads version from `tauri.conf.json`
2. `cargo tauri build` — produces `Queue.app` + `.dmg` in `desktop/src-tauri/target/release/bundle/`
3. Creates `Queue_<version>_x64.app.tar.gz` from `Queue.app` (the updater format — NOT the DMG)
4. Signs the tarball: `TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/queue.key) tauri signer sign <tarball>`
5. Writes `latest.json` with the new version, signature, pub_date, and release notes from `APP_CHANGES`
6. `gh release create` — uploads tarball, `.sig`, `.dmg`, and `latest.json` to GitHub

### Auto-updater mechanics
- Tauri fetches `latest.json` from: `https://github.com/smagalski/Queue-App/releases/latest/download/latest.json`
- This URL always resolves to the most recent release's `latest.json` asset
- The updater downloads `Queue_<version>_x64.app.tar.gz` (NOT the DMG — macOS updater requires the `.app.tar.gz` format)
- The tarball is verified against the minisign `.sig` before installation
- On successful download, `app.restart()` is called
- Update check happens 3 seconds after launch (in `lib.rs` `setup`) and is also manually triggerable from Settings → About

### Manual release (if release.sh fails partway)

```bash
# Sign a tarball manually
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/queue.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
./desktop/node_modules/.bin/tauri signer sign desktop/release/Queue_<version>_x64.app.tar.gz

# Create the GitHub release manually
gh release create "v<version>" \
  desktop/release/Queue_<version>_x64.app.tar.gz \
  desktop/release/Queue_<version>_x64.app.tar.gz.sig \
  desktop/release/Queue_<version>_x64.dmg \
  latest.json \
  --title "v<version>" --notes "..." \
  --repo smagalski/Queue-App
```

**Important**: The GitHub repo must be **public** for the Tauri updater to fetch assets without authentication. If you ever make it private, the auto-updater will break with 404s.

---

## Settings Panels

Settings are opened with `openSettings(tab)`. Tabs: `categories`, `stress`, `account`, `about`, `data`.

- **Categories** (`renderCategoryManager` in `categories.js`): add/rename/delete categories and their keywords. Changes auto-refresh the stress cat list via `_saveCategoryRules()`.
- **Stress Score** (`_renderStressCatList` in `categories.js`): sliders for Hours/Volume/Urgency weights + checkboxes for which categories count toward the score.
- **Account** (`_populateAccountPanel` in `firebase.js`): dynamically built — shows signed-in email, sync toggle, and password management. No static HTML in the panel div.
- **About** (`_populateAppDetails` in `firebase.js`): version, deploy date, changelog from `APP_CHANGES`. Shows "Check for updates" button in Tauri only.
- **Data**: static HTML in `index.html` / `mobile.html`.

---

## Day History

History docs live in Firestore at `users/{uid}/history/{YYYY-MM-DD}`.

`openHistoryOverlay()` in `endday.js` generates the last 30 days (extending back to the earliest recorded day), merges with Firestore docs, and renders:
- Days with a record → `renderHistoryDay(data)`
- Days with no record → `renderHistoryGapDay(dateStr)` — dashed card with "Day Off" / "Not Tracked" buttons
- `markHistoryDay(dateStr, type)` saves the choice to Firestore and replaces the gap card

Day doc schema:
```js
{
  date: 'YYYY-MM-DD',
  savedAt: timestamp,
  dayOff: true,          // OR
  dayNotTracked: true,   // OR
  doneTasks: [...],
  timePerTask: [...],
  priorityBreakdown: { urgent, high, medium, low, total },
  stressScore: number,
  taskCategoryOverrides: { [taskTitle]: catId },
}
```

---

## Streak

`streak.js` computes the current streak from `users/{uid}/history` and renders the widget. `refreshStreak()` is called after sign-in, after end-day, after day-off, and after wrap-up commit.

`prevDateStr()` (exported from `streak.js`) returns yesterday's date string in PST — used by `wrapup.js` to check if yesterday was resolved.

---

## Tauri-Specific Notes

- All Tauri commands are in `desktop/src-tauri/src/lib.rs`
- `window.__TAURI__` is present in the Tauri context; absent in browser
- Google OAuth in Tauri uses a local loopback server (`start_oauth_server`) + `open_in_browser` because popups don't work in WebViews
- The overlay window (`overlay.html`) is always-on-top, transparent, vibrancy-blurred, and draggable
- Main window focus hides the overlay; unfocus + minimize emits `main-window-minimized` event

---

## Firebase / Firestore Collections

```
users/{uid}/queue/state          # Main task doc (tasks, doneTasks, recurringTasks, categoryRules)
users/{uid}/history/{YYYY-MM-DD} # Day history docs
users/{uid}/gcal_settings        # Google Calendar import settings
user_requests/{uid}              # Access request docs (status: pending|approved|declined)
```

Access is invite-only. New users land on an approval screen until their `user_requests` doc status becomes `approved`.
