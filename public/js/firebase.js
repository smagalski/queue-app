import { state } from './state.js';
import { firebaseConfig, DEFAULT_CATEGORY_RULES, GCAL_DESKTOP_CLIENT_ID, GCAL_DESKTOP_CLIENT_SECRET, APP_VERSION, APP_DEPLOYED, APP_CHANGES } from './constants.js';
import { esc } from './utils.js';
import { setSyncStatus, load } from './persistence.js';
import { render } from './render.js';
import { renderCategoryManager, getStressWeights, _renderStressCatList } from './categories.js';
import { checkDayOffFirestore, checkDayEndedFirestore } from './endday.js';
import { maybeShowGcalDailyPrompt } from './gcal.js';
import { checkPreviousDayWrapUp } from './wrapup.js';

// ── Firebase init ──────────────────────────────────────────────────────────

const _configReady = !Object.values(firebaseConfig).some(v => v.startsWith('PASTE_'));

if (_configReady) {
  try {
    firebase.initializeApp(firebaseConfig);
    state.db   = firebase.firestore();
    state.auth = firebase.auth();
  } catch(e) {
    console.warn('[Queue] Firebase init failed:', e);
  }
}

// ── Auth helpers ───────────────────────────────────────────────────────────

let _authMode = 'signin';

export function toggleAuthMode() {
  _authMode = _authMode === 'signin' ? 'signup' : 'signin';
  const btn     = document.getElementById('authSubmitBtn');
  const sw      = document.getElementById('authSwitch');
  const forgot  = document.getElementById('authForgot');
  const keepRow = document.getElementById('authKeepRow');
  if (_authMode === 'signup') {
    btn.textContent = 'Create account';
    sw.innerHTML = 'Have an account? <a onclick="toggleAuthMode()">Sign in</a>';
    if (forgot)  forgot.style.display  = 'none';
    if (keepRow) keepRow.style.display = 'none';
  } else {
    btn.textContent = 'Sign in';
    sw.innerHTML = 'No account? <a onclick="toggleAuthMode()">Create one</a>';
    if (forgot)  forgot.style.display  = '';
    if (keepRow) keepRow.style.display = '';
  }
  document.getElementById('authError').textContent = '';
}

export function sendPasswordReset() {
  const email = document.getElementById('authEmail').value.trim();
  const err   = document.getElementById('authError');
  if (!email) { err.textContent = 'Enter your email address above first.'; return; }
  if (!state.auth) return;
  err.textContent = '';
  state.auth.sendPasswordResetEmail(email)
    .then(() => { err.style.color = 'var(--done-color)'; err.textContent = 'Reset email sent — check your inbox.'; })
    .catch(e  => { err.style.color = ''; err.textContent = friendlyAuthError(e.code); });
}

export function submitResetPassword() {
  const overlay = document.getElementById('resetPwOverlay');
  const oobCode = overlay._oobCode;
  const newPw   = document.getElementById('resetPwNew').value;
  const confirm = document.getElementById('resetPwConfirm').value;
  const err     = document.getElementById('resetPwError');
  const submit  = document.getElementById('resetPwSubmit');
  err.textContent = '';
  if (newPw.length < 6)  { err.textContent = 'Password must be at least 6 characters.'; return; }
  if (newPw !== confirm)  { err.textContent = 'Passwords do not match.'; return; }
  submit.disabled = true;
  state.auth.confirmPasswordReset(oobCode, newPw)
    .then(() => {
      overlay.classList.remove('active');
      const authErr = document.getElementById('authError');
      authErr.style.color   = 'var(--done-color)';
      authErr.textContent   = 'Password set! You can now sign in.';
    })
    .catch(e => {
      submit.disabled = false;
      err.textContent = friendlyAuthError(e.code) || 'Failed to set password.';
    });
}

export function submitAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const pass  = document.getElementById('authPassword').value;
  const err   = document.getElementById('authError');
  if (!email || !pass) { err.textContent = 'Please enter your email and password.'; return; }
  if (!state.auth) return;
  err.textContent = ''; err.style.color = '';
  const btn         = document.getElementById('authSubmitBtn');
  const keepChecked = document.getElementById('keepSignedIn')?.checked ?? true;
  btn.disabled = true;
  const persistence = keepChecked
    ? firebase.auth.Auth.Persistence.LOCAL
    : firebase.auth.Auth.Persistence.SESSION;
  state.auth.setPersistence(persistence)
    .then(() => _authMode === 'signup'
      ? state.auth.createUserWithEmailAndPassword(email, pass)
      : state.auth.signInWithEmailAndPassword(email, pass))
    .then(() => {
      if (keepChecked) localStorage.setItem('q_signin_ts', String(Date.now()));
      else             localStorage.removeItem('q_signin_ts');
      btn.disabled = false;
    })
    .catch(e => {
      btn.disabled = false;
      err.textContent = friendlyAuthError(e.code);
    });
}

async function _signInWithGoogleTauri() {
  if (!GCAL_DESKTOP_CLIENT_ID || !GCAL_DESKTOP_CLIENT_SECRET) {
    document.getElementById('authError').textContent =
      'Desktop Google sign-in is not configured. Set GCAL_DESKTOP_CLIENT_ID / GCAL_DESKTOP_CLIENT_SECRET in the source.';
    return;
  }
  const keepChecked = document.getElementById('keepSignedIn')?.checked ?? true;
  document.getElementById('authError').textContent = 'Opening browser for sign-in…';

  try {
    const port = await window.__TAURI__.core.invoke('start_oauth_server');
    const redirectUri = `http://127.0.0.1:${port}`;

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     GCAL_DESKTOP_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         'openid email profile');
    authUrl.searchParams.set('access_type',   'offline');
    authUrl.searchParams.set('prompt',        'select_account');
    await window.__TAURI__.core.invoke('open_in_browser', { url: authUrl.toString() });

    const redirectUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), 120000);
      window.__TAURI__.event.once('oauth-redirect', ev => {
        clearTimeout(timer); resolve(ev.payload);
      });
    });

    const code = new URL(redirectUrl).searchParams.get('code');
    if (!code) throw new Error('No auth code received');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, redirect_uri: redirectUri, grant_type: 'authorization_code',
        client_id: GCAL_DESKTOP_CLIENT_ID, client_secret: GCAL_DESKTOP_CLIENT_SECRET,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.id_token) throw new Error(tokens.error_description || 'Token exchange failed');

    const credential = firebase.auth.GoogleAuthProvider.credential(tokens.id_token);
    const persistence = keepChecked
      ? firebase.auth.Auth.Persistence.LOCAL
      : firebase.auth.Auth.Persistence.SESSION;
    await state.auth.setPersistence(persistence);
    await state.auth.signInWithCredential(credential);
    if (keepChecked) localStorage.setItem('q_signin_ts', String(Date.now()));
    else             localStorage.removeItem('q_signin_ts');
    document.getElementById('authError').textContent = '';
  } catch(e) {
    document.getElementById('authError').textContent = e.message || friendlyAuthError(e.code);
  }
}

export async function signInWithGoogle() {
  if (!state.auth) return;
  if (window.__TAURI__) { await _signInWithGoogleTauri(); return; }
  const keepChecked = document.getElementById('keepSignedIn')?.checked ?? true;
  const persistence = keepChecked
    ? firebase.auth.Auth.Persistence.LOCAL
    : firebase.auth.Auth.Persistence.SESSION;
  const provider = new firebase.auth.GoogleAuthProvider();
  state.auth.setPersistence(persistence)
    .then(() => state.auth.signInWithPopup(provider))
    .then(() => {
      if (keepChecked) localStorage.setItem('q_signin_ts', String(Date.now()));
      else             localStorage.removeItem('q_signin_ts');
    })
    .catch(e => {
      if (e.code === 'auth/popup-blocked') {
        document.getElementById('authError').textContent =
          'Pop-up blocked — allow pop-ups for this site in your browser, then try again.';
      } else if (e.code !== 'auth/popup-closed-by-user') {
        document.getElementById('authError').textContent = friendlyAuthError(e.code);
      }
    });
}

export function signOut() {
  if (!state.auth) return;
  localStorage.removeItem('q_signin_ts');
  state.auth.signOut().then(() => {
    state.tasks = []; state.doneTasks = [];
    try {
      localStorage.removeItem('q_tasks');
      localStorage.removeItem('q_done');
    } catch(e) {}
  });
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email':            'Invalid email address.',
    'auth/user-not-found':           'No account found with that email.',
    'auth/wrong-password':           'Incorrect password.',
    'auth/email-already-in-use':     'An account with that email already exists.',
    'auth/weak-password':            'Password must be at least 6 characters.',
    'auth/too-many-requests':        'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user':     '',
    'auth/invalid-credential':       'Current password is incorrect.',
    'auth/requires-recent-login':    'Please sign out and sign back in, then try again.',
    'auth/provider-already-linked':  'A password is already linked to this account.',
    'auth/expired-action-code':      'This reset link has expired. Please request a new one.',
    'auth/invalid-action-code':      'This reset link is invalid or has already been used.',
    'auth/network-request-failed':   'Network error — check your connection and try again.',
    'auth/internal-error':           'An internal error occurred. Please try again.',
    'auth/user-token-expired':       'Session expired. Please sign out and sign back in.',
    'auth/operation-not-allowed':    'This sign-in method is not enabled.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

export function showAuthScreen(visible) {
  const screen   = document.getElementById('authScreen');
  const gearWrap = document.getElementById('gearWrap');
  if (screen)   screen.classList.toggle('hidden', !visible);
  if (gearWrap) gearWrap.style.display = visible ? 'none' : '';
}

// ── Gear menu ──────────────────────────────────────────────────────────────

export function toggleGearMenu(e) {
  e.stopPropagation();
  document.getElementById('gearMenu').classList.toggle('open');
}

export function closeGearMenu() {
  const m = document.getElementById('gearMenu');
  if (m) m.classList.remove('open');
}

export function openSettings(tab) {
  tab = tab || 'categories';
  document.getElementById('settingsOverlay').classList.add('active');
  switchSettingsTab(tab);
}

export function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('active');
  const c7 = document.getElementById('confirmClear7');
  const ca = document.getElementById('confirmClearAll');
  if (c7) c7.classList.remove('visible');
  if (ca) ca.classList.remove('visible');
}

export function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('stab-' + tab).classList.add('active');
  document.getElementById('settingsPanel-' + tab).classList.add('active');
  if (tab === 'categories') {
    if (!state.categoryRules.length) state.categoryRules = JSON.parse(JSON.stringify(DEFAULT_CATEGORY_RULES));
    renderCategoryManager();
  } else if (tab === 'stress') {
    const w = getStressWeights();
    ['hours', 'volume', 'urgency'].forEach(k => {
      const key = k.charAt(0).toUpperCase() + k.slice(1);
      document.getElementById('stressSlider' + key).value = w[k];
      document.getElementById('stressVal'    + key).textContent = w[k];
    });
    _renderStressCatList();
  } else if (tab === 'account') {
    _populatePasswordPanel();
  } else if (tab === 'about') {
    _populateAppDetails();
  }
}

async function _populateAppDetails() {
  let version = APP_VERSION;
  if (window.__TAURI__) {
    try { version = await window.__TAURI__.core.invoke('get_version'); } catch(e) {}
    document.getElementById('updateCheckRow').style.display = '';
    document.getElementById('updateCheckStatus').textContent = '';
    document.getElementById('updateCheckBtn').disabled = false;
  }
  document.getElementById('appDetailsVersion').textContent  = 'v' + version;
  document.getElementById('appDetailsDeployed').textContent = APP_DEPLOYED;
  document.getElementById('appDetailsChangelog').innerHTML  =
    APP_CHANGES.map(c => `<div class="app-details-change">${esc(c)}</div>`).join('');
}

export async function checkForUpdates() {
  if (!window.__TAURI__) return;
  const btn    = document.getElementById('updateCheckBtn');
  const status = document.getElementById('updateCheckStatus');
  btn.disabled = true;
  status.textContent = 'Checking…';
  try {
    const result = await window.__TAURI__.core.invoke('manual_check_for_updates');
    status.textContent = result === 'up_to_date' ? 'You\'re up to date' : 'Update available';
  } catch(e) {
    status.textContent = 'Check failed';
  }
  btn.disabled = false;
}

function hasPasswordProvider() {
  return !!(state.currentUser && state.currentUser.providerData.some(p => p.providerId === 'password'));
}

function _populatePasswordPanel() {
  if (!state.currentUser) return;
  const hasPass = hasPasswordProvider();
  document.getElementById('pwModalTitle').textContent    = hasPass ? 'Change Password' : 'Set Password';
  document.getElementById('pwModalSubtitle').textContent = hasPass
    ? 'Enter your current password to verify, then choose a new one.'
    : 'Add a password to your account so you can sign in without Google.';
  document.getElementById('pwModalError').textContent = '';

  const fields = document.getElementById('pwModalFields');
  fields.innerHTML = (hasPass ? `<input class="auth-input" id="pwCurrent" type="password" placeholder="Current password" autocomplete="current-password"/>` : '') + `
    <input class="auth-input" id="pwNew"     type="password" placeholder="New password (min 6 chars)" autocomplete="new-password"/>
    <input class="auth-input" id="pwConfirm" type="password" placeholder="Confirm new password"       autocomplete="new-password"/>
  `;
  fields.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitPasswordModal(); });
  });
}

export function closePasswordModal() { closeSettings(); }

export function submitPasswordModal() {
  const err     = document.getElementById('pwModalError');
  const submit  = document.getElementById('pwModalSubmit');
  const newPw   = (document.getElementById('pwNew')     || {}).value || '';
  const confirm = (document.getElementById('pwConfirm') || {}).value || '';
  const current = (document.getElementById('pwCurrent') || {}).value || '';

  err.textContent = '';
  if (newPw.length < 6)      { err.textContent = 'Password must be at least 6 characters.'; return; }
  if (newPw !== confirm)     { err.textContent = 'Passwords do not match.'; return; }

  submit.disabled = true;
  const user = state.currentUser;

  if (hasPasswordProvider()) {
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, current);
    user.reauthenticateWithCredential(cred)
      .then(() => user.updatePassword(newPw))
      .then(() => { closePasswordModal(); })
      .catch(e => {
        submit.disabled = false;
        err.textContent = friendlyAuthError(e.code) || 'Failed to update password.';
      });
  } else {
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, newPw);
    user.linkWithCredential(cred)
      .then(() => { closePasswordModal(); })
      .catch(e => {
        submit.disabled = false;
        if (e.code === 'auth/requires-recent-login') {
          closeSettings();
          state.auth.signOut().then(() => {
            const authErr = document.getElementById('authError');
            authErr.style.color  = '';
            authErr.textContent  = 'Please sign back in with Google, then set your password in Settings.';
          });
        } else {
          err.textContent = friendlyAuthError(e.code) || 'Failed to set password.';
        }
      });
  }
}

function setUserDoc(user) {
  state.currentUser = user;
  state.stateDoc = user ? state.db.collection('users').doc(user.uid).collection('queue').doc('state') : null;
}

// ── Auth state observer ────────────────────────────────────────────────────

export function initAuth() {
  if (!state.auth) {
    showAuthScreen(false);
    return;
  }

  // Handle Google redirect result (fallback from popup-blocked)
  state.auth.getRedirectResult().then(result => {
    if (result && result.user) {
      const keepChecked = document.getElementById('keepSignedIn')?.checked ?? true;
      if (keepChecked) localStorage.setItem('q_signin_ts', String(Date.now()));
    }
  }).catch(() => {});

  let _approvalUnsub = null;

  function _enterApp(user) {
    setUserDoc(user);
    showAuthScreen(false);
    document.getElementById('approvalScreen').classList.add('hidden');
    load();
    checkDayOffFirestore();
    checkDayEndedFirestore();
    maybeShowGcalDailyPrompt();
    checkPreviousDayWrapUp();
  }

  function _showApprovalScreen(status) {
    const screen  = document.getElementById('approvalScreen');
    const title   = document.getElementById('approvalTitle');
    const body    = document.getElementById('approvalBody');
    const spin    = document.getElementById('approvalSpinner');
    const reqBtn  = document.getElementById('approvalRequestBtn');
    spin.style.display   = 'none';
    reqBtn.style.display = 'none';
    if (status === 'declined') {
      title.textContent = 'Access declined';
      body.textContent  = 'Your request to join Queue was declined. Contact the owner to appeal.';
    } else if (status === 'request') {
      title.textContent    = 'Access required';
      body.textContent     = 'Queue is invite-only. Request access and you\'ll be let in once approved.';
      reqBtn.style.display = '';
      reqBtn.disabled      = false;
      reqBtn.textContent   = 'Request Access';
    } else {
      title.textContent  = 'Request sent';
      body.innerHTML     = 'Your request to join Queue has been sent.<br>You\'ll be let in as soon as it\'s approved.';
      spin.style.display = '';
    }
    screen.classList.remove('hidden');
    showAuthScreen(false);
    const gw = document.getElementById('gearWrap');
    if (gw) gw.style.display = 'none';
  }

  // Exposed to window in main.js
  window.requestAccess = async function requestAccess() {
    const user = state.auth.currentUser;
    if (!user) return;
    const btn = document.getElementById('approvalRequestBtn');
    btn.disabled    = true;
    btn.textContent = 'Sending…';
    try {
      await state.db.collection('user_requests').doc(user.uid).set({
        status:    'pending',
        email:     user.email || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      _showApprovalScreen('pending');
      if (!_approvalUnsub) {
        const reqRef = state.db.collection('user_requests').doc(user.uid);
        _approvalUnsub = reqRef.onSnapshot(snap => {
          if (snap.data()?.status === 'approved') {
            if (_approvalUnsub) { _approvalUnsub(); _approvalUnsub = null; }
            _enterApp(user);
          }
        });
      }
    } catch(e) {
      btn.disabled    = false;
      btn.textContent = 'Request Access';
      document.getElementById('approvalBody').textContent = 'Something went wrong. Please try again.';
    }
  };

  state.auth.onAuthStateChanged(async user => {
    if (user) {
      const signinTs = localStorage.getItem('q_signin_ts');
      if (signinTs && Date.now() - parseInt(signinTs, 10) > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem('q_signin_ts');
        state.auth.signOut();
        return;
      }

      try {
        const reqRef  = state.db.collection('user_requests').doc(user.uid);
        const reqSnap = await reqRef.get();
        if (reqSnap.exists) {
          const status = reqSnap.data().status;
          if (status === 'approved') {
            // fall through to _enterApp below
          } else if (status === 'pending' || status === 'declined') {
            _showApprovalScreen(status);
            if (status === 'pending' && !_approvalUnsub) {
              _approvalUnsub = reqRef.onSnapshot(snap => {
                if (snap.data()?.status === 'approved') {
                  if (_approvalUnsub) { _approvalUnsub(); _approvalUnsub = null; }
                  _enterApp(user);
                }
              });
            }
            return;
          } else {
            _showApprovalScreen('request');
            return;
          }
        } else {
          _showApprovalScreen('request');
          return;
        }
      } catch(e) {
        if (e.code === 'permission-denied') { _showApprovalScreen('request'); return; }
      }

      _enterApp(user);
    } else {
      if (_approvalUnsub) { _approvalUnsub(); _approvalUnsub = null; }
      setUserDoc(null);
      if (state.unsubscribeSnapshot) { state.unsubscribeSnapshot(); state.unsubscribeSnapshot = null; }
      if (state.listenerRetryTimer) { clearTimeout(state.listenerRetryTimer); state.listenerRetryTimer = null; }
      state.tasks = []; state.doneTasks = []; state.recurringTasks = [];
      render();
      document.getElementById('approvalScreen').classList.add('hidden');
      showAuthScreen(true);
      setSyncStatus('offline');
    }
  });

  // Handle password reset link
  (function handleResetLink() {
    const params  = new URLSearchParams(window.location.search);
    const mode    = params.get('mode');
    const oobCode = params.get('oobCode');
    if (mode === 'resetPassword' && oobCode) {
      history.replaceState({}, '', window.location.pathname);
      const overlay  = document.getElementById('resetPwOverlay');
      overlay._oobCode = oobCode;
      overlay.classList.add('active');
    }
  })();
}
