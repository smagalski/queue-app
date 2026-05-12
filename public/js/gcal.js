import { state } from './state.js';
import { GCAL_CLIENT_ID, GCAL_DESKTOP_CLIENT_ID, GCAL_DESKTOP_CLIENT_SECRET } from './constants.js';
import { getPST, todayPstDateStr, fmtMins, pad2, esc } from './utils.js';
import { save } from './persistence.js';
import { render } from './render.js';

// ── Module-local state ─────────────────────────────────────────────────────

let _gcalTokenClient          = null;
let _gcalAccessToken          = null;
let _gcalTokenExpiry          = 0;
let _gcalPendingEvents        = null;
let _gcalPromptShownThisSession = false;
let _gcalAuthTimeout          = null;

// ── PKCE helpers ───────────────────────────────────────────────────────────

function _base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function _generatePkce() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier  = _base64urlEncode(verifierBytes);
  // Per RFC 7636: code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
  // Must hash the verifier *string*, not the raw random bytes.
  const digest        = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = _base64urlEncode(digest);
  return { codeVerifier, codeChallenge };
}

// ── Internal helpers ───────────────────────────────────────────────────────

function _gcalClearAuthTimeout() {
  if (_gcalAuthTimeout) { clearTimeout(_gcalAuthTimeout); _gcalAuthTimeout = null; }
}

function setGcalListMessage(msg) {
  const el = document.getElementById('gcalEventList');
  if (el) el.innerHTML = `<div class="gcal-empty">${msg}</div>`;
}

function _dateToMinsPST(date) {
  const tz = state.timezone || 'America/Los_Angeles';
  const p = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  return p.getHours() * 60 + p.getMinutes();
}

function updateGcalConfirmBtn() {
  const checked = document.querySelectorAll('.gcal-event-check:checked').length;
  const btn = document.getElementById('gcalConfirmBtn');
  if (!btn) return;
  btn.textContent = `Import ${checked} Task${checked !== 1 ? 's' : ''}`;
  btn.disabled = checked === 0;
}

// ── Tauri desktop OAuth (PKCE via system browser + local redirect server) ──

async function _gcalTauriOAuth() {
  if (!GCAL_DESKTOP_CLIENT_ID || !GCAL_DESKTOP_CLIENT_SECRET) {
    setGcalListMessage('Desktop OAuth is not configured yet. Set <code>GCAL_DESKTOP_CLIENT_ID</code> and <code>GCAL_DESKTOP_CLIENT_SECRET</code> in the source, then rebuild the app.');
    return;
  }

  setGcalListMessage('Opening Google sign-in in your browser…');

  try {
    // 1. Start the local redirect server — returns the random port it's listening on
    const port = await window.__TAURI__.core.invoke('start_oauth_server');
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // 2. Generate PKCE verifier / challenge
    const { codeVerifier, codeChallenge } = await _generatePkce();

    // 3. Register for the oauth-redirect event (fired by Rust after it receives the callback)
    let _unlisten = null;
    const authPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (_unlisten) _unlisten();
        reject(new Error('Sign-in timed out. Please try again.'));
      }, 180000); // 3 minutes

      window.__TAURI__.event.listen('oauth-redirect', (evt) => {
        clearTimeout(timeout);
        if (_unlisten) _unlisten();
        resolve(evt.payload);
      }).then(fn => { _unlisten = fn; });
    });

    // 4. Build the Google authorization URL
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',             GCAL_DESKTOP_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',          redirectUri);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('scope',                 'https://www.googleapis.com/auth/calendar.readonly');
    authUrl.searchParams.set('code_challenge',        codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type',           'online');

    // 5. Open the auth URL in the system browser
    await window.__TAURI__.core.invoke('open_in_browser', { url: authUrl.toString() });

    // 6. Wait for the redirect
    const redirectUrl = await authPromise;
    const params = new URL(redirectUrl).searchParams;
    const code   = params.get('code');
    const error  = params.get('error');

    if (error) {
      if (error === 'access_denied') { closeGcalLightbox(); }
      else { setGcalListMessage(`Sign-in failed: ${error}. Please try again.`); }
      return;
    }
    if (!code) {
      setGcalListMessage('Sign-in failed: no authorization code received. Please try again.');
      return;
    }

    // 7. Exchange the authorization code for an access token
    setGcalListMessage('Completing sign-in…');
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GCAL_DESKTOP_CLIENT_ID,
        client_secret: GCAL_DESKTOP_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    });
    const tokenData = await tokenResp.json();
    if (tokenData.error) {
      setGcalListMessage(`Sign-in failed: ${tokenData.error_description || tokenData.error}. Please try again.`);
      return;
    }

    _gcalAccessToken = tokenData.access_token;
    _gcalTokenExpiry = Date.now() + (tokenData.expires_in - 60) * 1000;
    fetchGcalEvents();

  } catch (err) {
    setGcalListMessage(`Sign-in error: ${err.message || String(err)}. Please try again.`);
  }
}

// ── Web OAuth token client ─────────────────────────────────────────────────

function _buildGcalTokenClient(onSuccess) {
  return google.accounts.oauth2.initTokenClient({
    client_id: GCAL_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    callback(resp) {
      _gcalClearAuthTimeout();
      if (resp.error) {
        console.error('GCal OAuth error:', resp.error);
        if (resp.error === 'access_denied' || resp.error === 'popup_closed_by_user') {
          closeGcalLightbox();
        } else {
          setGcalListMessage(`Sign-in failed: ${resp.error}. Please try again.`);
        }
        return;
      }
      _gcalAccessToken = resp.access_token;
      _gcalTokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      onSuccess();
    },
    error_callback(err) {
      _gcalClearAuthTimeout();
      console.error('GCal token client error:', err);
      const type = err && err.type;
      if (type === 'popup_failed_to_open') {
        setGcalListMessage('Sign-in popup was blocked. Please allow popups for this site and try again.');
      } else if (type === 'popup_closed') {
        closeGcalLightbox();
      } else {
        setGcalListMessage(`Sign-in failed (${type || 'unknown error'}). Make sure this app's URL is an authorized origin in Google Cloud Console, then try again.`);
      }
    },
  });
}

// ── Daily prompt ───────────────────────────────────────────────────────────

export function maybeShowGcalDailyPrompt() {
  if (!GCAL_CLIENT_ID) return;
  if (_gcalPromptShownThisSession) return;   // already shown this session
  const today = new Date().toDateString();
  const uid = state.currentUser?.uid;
  const key = uid ? `q_gcal_prompt_date_${uid}` : 'q_gcal_prompt_date';
  if (localStorage.getItem(key) === today) return;
  _gcalPromptShownThisSession = true;
  document.getElementById('gcalDailyPrompt').classList.add('active');
}

export function dismissGcalDailyPrompt(importNow) {
  const uid = state.currentUser?.uid;
  const key = uid ? `q_gcal_prompt_date_${uid}` : 'q_gcal_prompt_date';
  localStorage.setItem(key, new Date().toDateString());
  document.getElementById('gcalDailyPrompt').classList.remove('active');
  if (importNow) openGcalImport();
}

// ── Open lightbox ──────────────────────────────────────────────────────────

export function openGcalImport() {
  if (!GCAL_CLIENT_ID) {
    alert('Google Calendar import is not configured.\n\nSet GCAL_CLIENT_ID in the source to your OAuth 2.0 Web Client ID.');
    return;
  }
  document.getElementById('gcalOverlay').classList.add('active');
  document.getElementById('gcalConfirmBtn').style.display = 'none';

  // Tauri desktop: use system browser + local redirect server (PKCE) instead of a popup.
  if (window.__TAURI__) {
    _gcalTauriOAuth();
    return;
  }

  setGcalListMessage('Connecting to Google…');

  if (_gcalAccessToken && Date.now() < _gcalTokenExpiry) {
    fetchGcalEvents();
    return;
  }
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    setGcalListMessage('Google sign-in library not loaded. Check your internet connection and try again.');
    return;
  }
  _gcalTokenClient = _buildGcalTokenClient(fetchGcalEvents);
  _gcalTokenClient.requestAccessToken({ prompt: '' });

  // Fallback: if neither callback fires in 20s, the popup was likely silently blocked
  _gcalAuthTimeout = setTimeout(() => {
    _gcalAuthTimeout = null;
    setGcalListMessage('Sign-in timed out. The popup may have been blocked — allow popups for this site and try again.');
  }, 20000);
}

// ── Fetch events ───────────────────────────────────────────────────────────

export async function fetchGcalEvents() {
  const overlay = document.getElementById('gcalOverlay');
  setGcalListMessage('Loading…');
  document.getElementById('gcalConfirmBtn').style.display = 'none';
  overlay.classList.add('active');

  // Build today's date range in user's timezone with a timezone-independent offset computation.
  const now   = new Date();
  const tz    = state.timezone || 'America/Los_Angeles';
  const laStr = now.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const [datePart, timePart] = laStr.split(', ');
  const [mo2, d2, y2] = datePart.split('/');
  const [h2, min2, s2] = timePart.split(':').map(Number);
  const laAsUtcMs  = Date.UTC(parseInt(y2), parseInt(mo2) - 1, parseInt(d2), h2, min2, s2);
  const rawOffMins = Math.round((laAsUtcMs - now.getTime()) / 60000); // neg for US timezones
  const sign       = rawOffMins >= 0 ? '+' : '-';
  const absOff     = Math.abs(rawOffMins);
  const offsetStr  = `${sign}${pad2(Math.floor(absOff / 60))}:${pad2(absOff % 60)}`;
  const timeMin    = `${y2}-${mo2}-${d2}T00:00:00${offsetStr}`;
  const timeMax    = `${y2}-${mo2}-${d2}T23:59:59${offsetStr}`;

  const authHeaders = { Authorization: `Bearer ${_gcalAccessToken}` };

  const handle401 = () => {
    _gcalAccessToken = null;
    _gcalTokenExpiry = 0;
    setGcalListMessage('Re-authenticating with Google…');
    _gcalTokenClient = _buildGcalTokenClient(fetchGcalEvents);
    _gcalTokenClient.requestAccessToken({ prompt: 'consent' });
  };

  try {
    // 1. Get all calendars the user has access to (includes invited/shared)
    const listRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      { headers: authHeaders }
    );
    if (listRes.status === 401) { handle401(); return; }
    if (!listRes.ok) { setGcalListMessage('Failed to load calendars. Please try again.'); return; }
    const listData  = await listRes.json();
    const calendars = (listData.items || []).filter(c => c.accessRole !== 'none');

    // 2. Fetch today's events from each calendar in parallel
    const fetchCal = async (calId) => {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
      url.searchParams.set('timeMin',       timeMin);
      url.searchParams.set('timeMax',       timeMax);
      url.searchParams.set('singleEvents',  'true');
      url.searchParams.set('orderBy',       'startTime');
      url.searchParams.set('maxResults',    '100');
      const r = await fetch(url.toString(), { headers: authHeaders });
      if (!r.ok) return [];
      const data = await r.json();
      return data.items || [];
    };

    const results = await Promise.all(calendars.map(c => fetchCal(c.id)));

    // 3. Merge, deduplicate by id, filter out all-day and declined events
    const seen   = new Set();
    const events = [];
    for (const items of results) {
      for (const e of items) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (!e.start || !e.start.dateTime) continue; // skip all-day
        // Skip events the user declined
        const selfAttendee = (e.attendees || []).find(a => a.self);
        if (selfAttendee && selfAttendee.responseStatus === 'declined') continue;
        events.push(e);
      }
    }
    // Sort by start time
    events.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

    _gcalPendingEvents = events;
    renderGcalEvents(events);
  } catch (e) {
    setGcalListMessage('Error loading events. Please try again.');
  }
}

// ── Render event list ──────────────────────────────────────────────────────

export function renderGcalEvents(events) {
  const list       = document.getElementById('gcalEventList');
  const confirmBtn = document.getElementById('gcalConfirmBtn');

  if (!events.length) {
    setGcalListMessage('No events found for today.');
    if (confirmBtn) confirmBtn.style.display = 'none';
    return;
  }

  if (confirmBtn) confirmBtn.style.display = '';
  list.innerHTML = events.map((e, i) => {
    const startMins = _dateToMinsPST(new Date(e.start.dateTime));
    const noEnd     = !e.end || !e.end.dateTime;
    const endMins   = noEnd ? startMins + 30 : _dateToMinsPST(new Date(e.end.dateTime));
    const dur       = endMins - startMins;
    const durStr    = dur >= 60
      ? `${Math.floor(dur / 60)}h${dur % 60 > 0 ? ` ${dur % 60}m` : ''}`
      : `${dur}m`;
    return `<div class="gcal-event-row checked" id="gcalRow_${i}" onclick="toggleGcalRow(${i})">
      <input type="checkbox" class="gcal-event-check" id="gcalChk_${i}" checked
             onclick="event.stopPropagation()" onchange="updateGcalRow(${i})"/>
      <div class="gcal-event-info">
        <div class="gcal-event-title">${esc(e.summary || '(No title)')}</div>
        <div class="gcal-event-meta">
          <span>${fmtMins(startMins)} – ${fmtMins(endMins)}</span>
          <span>${durStr}</span>
          ${noEnd ? '<span class="gcal-est-badge">estimated end</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  updateGcalConfirmBtn();
}

export function toggleGcalRow(i) {
  const chk = document.getElementById(`gcalChk_${i}`);
  if (!chk) return;
  chk.checked = !chk.checked;
  updateGcalRow(i);
}

export function updateGcalRow(i) {
  const chk = document.getElementById(`gcalChk_${i}`);
  if (!chk) return;
  document.getElementById(`gcalRow_${i}`).classList.toggle('checked', chk.checked);
  updateGcalConfirmBtn();
}

// ── Import selected events ─────────────────────────────────────────────────

export function importGcalTasks() {
  if (!_gcalPendingEvents) return;
  const dp = todayPstDateStr();
  let count = 0;
  _gcalPendingEvents.forEach((e, i) => {
    const chk = document.getElementById(`gcalChk_${i}`);
    if (!chk || !chk.checked) return;
    const startMins = _dateToMinsPST(new Date(e.start.dateTime));
    const noEnd     = !e.end || !e.end.dateTime;
    const rawEnd    = noEnd ? startMins + 30 : _dateToMinsPST(new Date(e.end.dateTime));
    const endMins   = rawEnd > startMins ? rawEnd : startMins + 30;
    const dur       = endMins - startMins;
    state.tasks.push({
      id:        Date.now() + count,
      type:      'scheduled',
      title:     (e.summary || 'Calendar Event').slice(0, 120),
      addedAt:   Date.now(),
      startTime: `${dp}T${fmtMins(startMins)}`,
      endTime:   `${dp}T${fmtMins(endMins)}`,
      duration:  dur,
    });
    count++;
  });
  if (count > 0) { save(); render(); }
  closeGcalLightbox();
}

// ── Close lightbox ─────────────────────────────────────────────────────────

export function closeGcalLightbox() {
  _gcalClearAuthTimeout();
  document.getElementById('gcalOverlay').classList.remove('active');
  _gcalPendingEvents = null;
}
