import { state } from './state.js';
import { DEFAULT_CATEGORY_RULES, STRESS_DEFAULTS, CAT_TALLY_COLORS, DAYS, MONTHS, P_COLS, P_TEXT, P_NAMES } from './constants.js';
import { getPST, parseDateLocalMins, fmtTaskMins, esc, pad2, renderClockDisplay } from './utils.js';
import { save } from './persistence.js';

// ── Category helpers ───────────────────────────────────────────────────────

// Returns the category id for a task.
// Priority: sessionOverrides > taskOverride > keyword match.
// taskOverride = task.categoryOverride (set when user manually picks a category).
export function getCategoryForTask(title, overrides, taskId, taskOverride) {
  if (overrides && taskId != null && overrides[taskId] != null) return overrides[taskId];
  if (taskOverride != null) return taskOverride;
  if (!state.categoryRules.length) return 'other';
  const lower = String(title || '').toLowerCase();
  for (const cat of state.categoryRules) {
    if (!cat.keywords || !cat.keywords.length) continue; // skip catch-all
    if (cat.keywords.some(kw => lower.includes(kw.toLowerCase()))) return cat.id;
  }
  return state.categoryRules[state.categoryRules.length - 1].id; // last = catch-all
}

// ── Category tally (live panel in left panel) ──────────────────────────────

export function renderCategoryTally() {
  const el = document.getElementById('catTallyRows');
  if (!el) return;
  if (!state.categoryRules.length) { el.innerHTML = ''; return; }

  const todayStr = getPST().toDateString();
  const catMins  = {};
  for (const cat of state.categoryRules) catMins[cat.id] = 0;

  // Sum completed tasks for today
  for (const task of state.doneTasks) {
    if (task.isBreak) continue;
    const donePst = new Date(new Date(task.doneAt).toLocaleString('en-US', { timeZone: state.timezone || 'America/Los_Angeles' }));
    if (donePst.toDateString() !== todayStr) continue;
    let mins = 0;
    if (task.startTime && task.endTime) {
      mins = parseDateLocalMins(task.endTime) - parseDateLocalMins(task.startTime);
    } else {
      mins = task.duration || 0;
    }
    if (mins <= 0) continue;
    const catId = getCategoryForTask(task.title, {}, task.id, task.categoryOverride);
    if (catMins[catId] !== undefined) catMins[catId] += mins;
    else catMins[state.categoryRules[state.categoryRules.length - 1].id] += mins;
  }

  const entries = state.categoryRules
    .map((cat, i) => ({ cat, mins: catMins[cat.id] || 0, color: CAT_TALLY_COLORS[i % CAT_TALLY_COLORS.length] }))
    .filter(e => e.mins > 0);

  if (entries.length === 0) {
    el.innerHTML = '<div class="cat-tally-empty">No activity yet</div>';
    return;
  }

  const maxMins = Math.max(...entries.map(e => e.mins));
  el.innerHTML = entries.map(({ cat, mins, color }) => {
    const pct = maxMins > 0 ? Math.round((mins / maxMins) * 100) : 0;
    return `<div class="cat-tally-row">
      <span class="cat-tally-name" style="color:#fff">${esc(cat.name.toUpperCase())}</span>
      <div class="cat-tally-bar-wrap"><div class="cat-tally-bar" style="width:${pct}%;background:rgba(255,255,255,0.5)"></div></div>
      <span class="cat-tally-time">${fmtTaskMins(mins)}</span>
    </div>`;
  }).join('');
}

// ── Clock (calls renderCategoryTally — lives here to avoid utils → categories cycle) ──

export function updateClock() {
  renderClockDisplay(); // updates #clockTime, #clockAmpm, #clockDate
  renderCategoryTally();
}

// ── Stress Score Weights ───────────────────────────────────────────────────

function _stressKey(name) {
  const uid = state.currentUser?.uid;
  return uid ? `q_${name}_${uid}` : `q_${name}`;
}

export function getStressWeights() {
  try {
    const saved = JSON.parse(localStorage.getItem(_stressKey('stress_weights')) || 'null');
    if (saved && typeof saved.hours === 'number') return saved;
  } catch(e) {}
  return { ...STRESS_DEFAULTS };
}

export function getStressExcludedCats() {
  try {
    const saved = JSON.parse(localStorage.getItem(_stressKey('stress_excluded_cats')) || 'null');
    if (Array.isArray(saved)) return new Set(saved);
  } catch(e) {}
  return new Set(); // default: all categories included
}

export function onStressCatToggle(catId, checked) {
  const excluded = getStressExcludedCats();
  if (checked) excluded.delete(catId);
  else excluded.add(catId);
  localStorage.setItem(_stressKey('stress_excluded_cats'), JSON.stringify([...excluded]));
}

export function _renderStressCatList() {
  const excluded = getStressExcludedCats();
  const el = document.getElementById('stressCatList');
  if (!el) return;
  el.innerHTML = state.categoryRules.map(cat => {
    const checked = !excluded.has(cat.id);
    return `<label class="stress-cat-row">
      <input type="checkbox" ${checked ? 'checked' : ''}
        onchange="onStressCatToggle('${cat.id.replace(/'/g,"\\'")}', this.checked)">
      <span>${esc(cat.name)}</span>
    </label>`;
  }).join('');
}

export function onStressSlider(factor, val) {
  const key = factor.charAt(0).toUpperCase() + factor.slice(1);
  document.getElementById('stressVal' + key).textContent = val;
  const w = getStressWeights();
  w[factor] = Number(val);
  localStorage.setItem(_stressKey('stress_weights'), JSON.stringify(w));
}

export function resetStressWeights() {
  localStorage.setItem(_stressKey('stress_weights'), JSON.stringify(STRESS_DEFAULTS));
  localStorage.removeItem(_stressKey('stress_excluded_cats'));
  ['hours', 'volume', 'urgency'].forEach(k => {
    const key = k.charAt(0).toUpperCase() + k.slice(1);
    document.getElementById('stressSlider' + key).value = STRESS_DEFAULTS[k];
    document.getElementById('stressVal'    + key).textContent = STRESS_DEFAULTS[k];
  });
  _renderStressCatList();
}

export function _recomputeStressScore(day) {
  if (!day.doneTasks || !day.doneTasks.length) return null;
  const rules       = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;
  const otherCatId  = rules[rules.length - 1].id;
  const overrides   = day.taskCategoryOverrides || {};
  const excluded    = getStressExcludedCats();
  const OTHER_WEIGHT = 0.3;
  const _catOf = t => getCategoryForTask(t.title, overrides, t.title, t.categoryOverride);
  const _stressW = t => _catOf(t) === otherCatId ? OTHER_WEIGHT : 1.0;

  const nonBreak = day.doneTasks.filter(t => !t.isBreak && !excluded.has(_catOf(t)));
  const _stressTimeMap = {};
  let urgencyRaw = 0, sTotal = 0;
  for (const t of nonBreak) {
    const w = _stressW(t);
    sTotal += w;
    if (t.priority === 1 || t.priority === 2) urgencyRaw += w;
    let mins = 0;
    if (t.startTime && t.endTime) mins = parseDateLocalMins(t.endTime) - parseDateLocalMins(t.startTime);
    else mins = t.duration || 0;
    if (mins > 0) _stressTimeMap[t.title || 'Untitled'] = (_stressTimeMap[t.title || 'Untitled'] || 0) + mins * w;
  }
  const workMins  = Object.values(_stressTimeMap).reduce((s, m) => s + m, 0);
  const workHours = workMins / 60;

  const urgencyNorm = Math.min(urgencyRaw, 10) / 10;
  const volumeNorm  = (Math.min(Math.max(sTotal, 3), 20) - 3) / 17;
  const hoursNorm   = (Math.min(Math.max(workHours, 4), 12) - 4) / 8;
  const sw = getStressWeights();
  const swTotal = (sw.hours + sw.volume + sw.urgency) || 1;
  const raw = (sw.hours * hoursNorm + sw.volume * volumeNorm + sw.urgency * urgencyNorm) / swTotal * 10;
  return Math.min(Math.max(Math.round(raw), 1), 10);
}

// ── Category Manager ───────────────────────────────────────────────────────

function _saveCategoryRules() {
  save(); // persists categoryRules via the main save()
  _renderStressCatList(); // keep "Count Towards Score" in sync
}

export function renderCategoryManager() {
  const rules = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;
  const body  = document.getElementById('catMgrBody');
  if (!body) return;

  body.innerHTML = rules.map((cat, i) => {
    const isCatchAll = !cat.keywords || cat.keywords.length === 0;
    const chipsHtml  = isCatchAll
      ? `<span class="cat-mgr-no-kw">Catches everything not matched above</span>`
      : (cat.keywords.length
          ? cat.keywords.map(kw =>
              `<span class="cat-mgr-chip">${esc(kw)}<button class="cat-mgr-chip-remove" onclick="removeCategoryKeyword('${esc(cat.id)}','${esc(kw)}')" title="Remove">✕</button></span>`
            ).join('')
          : '<span class="cat-mgr-no-kw">No keywords — add one below</span>'
        );

    const addKwRow = isCatchAll ? '' : `
      <div class="cat-mgr-add-kw">
        <input id="catKwInput_${esc(cat.id)}" placeholder="Add keyword…" maxlength="40"
               onkeydown="if(event.key==='Enter')addCategoryKeyword('${esc(cat.id)}')"/>
        <button class="cat-mgr-add-kw-btn" onclick="addCategoryKeyword('${esc(cat.id)}')">Add</button>
      </div>`;

    // "Other" (last / catch-all) cannot be deleted
    const deleteBtn = (i === rules.length - 1)
      ? ''
      : `<button class="cat-mgr-delete-btn" onclick="deleteCategory('${esc(cat.id)}')">Delete</button>`;

    return `<div class="cat-mgr-card">
      <div class="cat-mgr-card-header">
        <span class="cat-mgr-cat-name">${esc(cat.name)}</span>
        ${deleteBtn}
      </div>
      <div class="cat-mgr-chips" id="catChips_${esc(cat.id)}">${chipsHtml}</div>
      ${addKwRow}
    </div>`;
  }).join('');
}

export function addCategoryKeyword(catId) {
  const input = document.getElementById(`catKwInput_${catId}`);
  if (!input) return;
  const kw = input.value.trim().toLowerCase();
  if (!kw) return;
  const cat = state.categoryRules.find(c => c.id === catId);
  if (!cat) return;
  if (!cat.keywords.includes(kw)) {
    cat.keywords.push(kw);
    _saveCategoryRules();
  }
  input.value = '';
  renderCategoryManager();
}

export function removeCategoryKeyword(catId, kw) {
  const cat = state.categoryRules.find(c => c.id === catId);
  if (!cat) return;
  cat.keywords = cat.keywords.filter(k => k !== kw);
  _saveCategoryRules();
  renderCategoryManager();
}

export function addCategory() {
  const input = document.getElementById('catMgrNewName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  // Insert before the last catch-all entry
  const newCat = { id: 'cat_' + Date.now(), name, keywords: [] };
  const lastIdx = state.categoryRules.length - 1;
  state.categoryRules.splice(Math.max(lastIdx, 0), 0, newCat);
  input.value = '';
  _saveCategoryRules();
  renderCategoryManager();
}

export function deleteCategory(catId) {
  state.categoryRules = state.categoryRules.filter(c => c.id !== catId);
  _saveCategoryRules();
  renderCategoryManager();
}

// ── Data clearing ──────────────────────────────────────────────────────────

export function showConfirmClear7()   { document.getElementById('confirmClear7').classList.add('visible'); }
export function hideConfirmClear7()   { document.getElementById('confirmClear7').classList.remove('visible'); }
export function showConfirmClearAll() { document.getElementById('confirmClearAll').classList.add('visible'); }
export function hideConfirmClearAll() { document.getElementById('confirmClearAll').classList.remove('visible'); }

function _showHistoryToast(msg) {
  let toast = document.getElementById('historyDeleteToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'historyDeleteToast';
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:#1e1b2e; border:1px solid rgba(255,255,255,0.15); color:#fff;
      padding:10px 20px; border-radius:8px; font-size:12px; font-weight:600;
      z-index:99999; opacity:0; transition:opacity 0.2s; pointer-events:none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

export function clearOldHistory() {
  hideConfirmClear7();
  if (!state.db || !state.currentUser) return;
  const cutoff = new Date(getPST());
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = `${cutoff.getFullYear()}-${pad2(cutoff.getMonth()+1)}-${pad2(cutoff.getDate())}`;

  state.db.collection('users').doc(state.currentUser.uid).collection('history')
    .where('date', '<', cutoffStr)
    .get()
    .then(snap => {
      if (snap.empty) { _showHistoryToast('No history older than 7 days.'); return; }
      const batch = state.db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      return batch.commit().then(() => {
        _showHistoryToast(`Deleted ${snap.size} day${snap.size === 1 ? '' : 's'} of history.`);
        if (document.getElementById('historyOverlay').classList.contains('active')) {
          window.openHistoryOverlay?.();
        }
      });
    })
    .catch(err => {
      console.error('[Queue] Clear history failed:', err);
      _showHistoryToast('Error deleting history. Please try again.');
    });
}

export function clearAllHistory() {
  hideConfirmClearAll();
  if (!state.db || !state.currentUser) return;
  state.db.collection('users').doc(state.currentUser.uid).collection('history')
    .get()
    .then(snap => {
      if (snap.empty) { _showHistoryToast('No history to delete.'); return; }
      const batch = state.db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      return batch.commit().then(() => {
        _showHistoryToast(`Deleted all history (${snap.size} day${snap.size === 1 ? '' : 's'}).`);
        if (document.getElementById('historyOverlay').classList.contains('active')) {
          window.openHistoryOverlay?.();
        }
      });
    })
    .catch(err => {
      console.error('[Queue] Clear all history failed:', err);
      _showHistoryToast('Error deleting history. Please try again.');
    });
}
