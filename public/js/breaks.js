import { state } from './state.js';
import { DEFAULT_DUR } from './constants.js';
import { getPST, todayPstDateStr, fmtMins, pad2, fmtBudgetMins, parseDateLocalMins, msMinsToCalMins } from './utils.js';
import { save } from './persistence.js';
import { render, isScheduled, getAllSorted } from './render.js';
import { markDoneById } from './taskactions.js';

// ── Break state persistence ────────────────────────────────────────────────

function _breakKey() { return state.currentUser?.uid ? `q_break_${state.currentUser.uid}` : null; }

export function loadBreakState() {
  const key = _breakKey();
  try {
    const s = key ? JSON.parse(localStorage.getItem(key) || '{}') : {};
    const today = todayPstDateStr();
    state.breakBudgetMins    = s.budget ?? 60;
    state.autoBreakAfterTask = !!s.autoBreak;
    state.autoBreakMins      = s.autoBreakMins ?? 5;
    state.breakUsedMins = s.day === today ? (s.used ?? 0) : 0;
    state.breakDay      = today;
    const sel = document.getElementById('breakBudgetSelect');
    if (sel) { const opt = [...sel.options].find(o => parseInt(o.value) === state.breakBudgetMins); if (opt) sel.value = String(state.breakBudgetMins); }
    const durSel = document.getElementById('autoBreakMinsSelect');
    if (durSel) { const opt = [...durSel.options].find(o => parseInt(o.value) === state.autoBreakMins); if (opt) durSel.value = String(state.autoBreakMins); }
    const toggle = document.getElementById('autoBreakToggle');
    if (toggle) toggle.checked = state.autoBreakAfterTask;
  } catch(e) {}
  updateBreakUI();
}

export function saveBreakState() {
  const key = _breakKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      budget:        state.breakBudgetMins,
      used:          state.breakUsedMins,
      day:           state.breakDay || todayPstDateStr(),
      autoBreak:     state.autoBreakAfterTask,
      autoBreakMins: state.autoBreakMins,
    }));
  } catch(e) {}
}

// ── Break settings ─────────────────────────────────────────────────────────

export function setAutoBreakAfterTask(on) {
  state.autoBreakAfterTask = on;
  if (!on) {
    state.suppressAutoBreakBefore.clear();
    state.forceBreakBefore.clear();
    if (state.autoBreakPrompting) {
      state.autoBreakPrompting = false;
      document.getElementById('autoBreakPrompt').classList.remove('active');
    }
  }
  saveBreakState();
  save(); render();
}

export function setAutoBreakMins(v) {
  state.autoBreakMins = parseInt(v) || 5;
  saveBreakState();
  save(); render();
}

export function setBreakBudget(v) {
  state.breakBudgetMins = parseInt(v) || 60;
  saveBreakState();
  updateBreakUI();
}

// ── Take a break ───────────────────────────────────────────────────────────

export function takeBreak() {
  const all     = getAllSorted();
  const nowTask = all[0];
  if (state.breakStartMs) return;

  const pst     = getPST();
  const nowMins = pst.getHours() * 60 + pst.getMinutes();

  if (nowTask) {
    let remaining = nowTask.duration || DEFAULT_DUR;
    if (!isScheduled(nowTask) && nowTask.calStartTime) {
      const elapsedMins = Math.floor((Date.now() - nowTask.calStartTime) / 60000);
      remaining = Math.max((nowTask.duration || DEFAULT_DUR) - elapsedMins, 1);
    } else if (isScheduled(nowTask) && nowTask._etMins != null) {
      remaining = Math.max(nowTask._etMins - nowMins, 1);
    }

    state.tasks = state.tasks.filter(t => t.id !== nowTask.id);
    const doneAt = Date.now();
    const dp     = todayPstDateStr();
    const doneEntry = { ...nowTask, doneAt };
    delete doneEntry._eff; delete doneEntry._stMins; delete doneEntry._etMins; delete doneEntry._active;
    if (isScheduled(nowTask) && nowTask.startTime) {
      doneEntry.endTime = `${dp}T${fmtMins(nowMins)}`;
    } else if (!isScheduled(nowTask) && nowTask.calStartTime) {
      doneEntry.startTime = `${dp}T${fmtMins(msMinsToCalMins(nowTask.calStartTime))}`;
      doneEntry.endTime   = `${dp}T${fmtMins(nowMins)}`;
    }
    state.doneTasks.unshift(doneEntry);

    state.tasks.forEach(t => {
      if (!isScheduled(t) && t.flexOrder !== undefined) t.flexOrder += 2;
    });

    const bId = Date.now();
    const rId = bId + 1;
    const breakTask = {
      id: bId, title: 'BREAK', priority: 1,
      addedAt: Date.now(), duration: state.breakBudgetMins, flexOrder: 0, isBreak: true,
    };
    const resumeTask = {
      id: rId, title: nowTask.title,
      priority: nowTask.priority || 3,
      addedAt: Date.now() + 1, duration: remaining, flexOrder: 1,
    };
    state.tasks.push(breakTask, resumeTask);
    state.breakTaskId = bId;
  } else {
    state.tasks.forEach(t => {
      if (!isScheduled(t) && t.flexOrder !== undefined) t.flexOrder += 1;
    });
    const bId = Date.now();
    const breakTask = {
      id: bId, title: 'BREAK', priority: 1,
      addedAt: Date.now(), duration: state.breakBudgetMins, flexOrder: 0, isBreak: true,
    };
    state.tasks.push(breakTask);
    state.breakTaskId = bId;
  }

  state.breakStartMs = Date.now();
  state.breakIsAuto  = false;

  save(); render();

  const badge = document.getElementById('breakTypeBadge');
  if (badge) badge.textContent = 'Manual';
  updateBreakTimer();
  document.getElementById('breakOverlay').classList.add('active');
  state.breakTimerInt = setInterval(updateBreakTimer, 1000);
}

// ── Auto-break prompt ──────────────────────────────────────────────────────

function _suppressCurrentAutoBreak() {
  const flex = state.tasks.filter(t => !isScheduled(t))
    .sort((a, b) => (a.flexOrder ?? Infinity) - (b.flexOrder ?? Infinity)
                 || a.priority - b.priority || a.addedAt - b.addedAt);
  const breakIdx = flex.findIndex(t => t._ab && t.isBreak);
  const nextTask = breakIdx >= 0 ? flex[breakIdx + 1] : null;
  if (nextTask) {
    state.suppressAutoBreakBefore.add(nextTask.id);
    state.forceBreakBefore.delete(nextTask.id);
  }
}

export function startAutoBreak() {
  state.autoBreakPrompting = false;
  document.getElementById('autoBreakPrompt').classList.remove('active');
  _suppressCurrentAutoBreak();

  state.breakIsAuto  = true;
  state.breakStartMs = Date.now();
  state.breakTaskId  = null;

  const badge = document.getElementById('breakTypeBadge');
  if (badge) badge.textContent = 'Automatic';
  save(); render();
  updateBreakTimer();
  document.getElementById('breakOverlay').classList.add('active');
  if (!state.breakTimerInt) state.breakTimerInt = setInterval(updateBreakTimer, 1000);
}

export function skipAutoBreak() {
  state.autoBreakPrompting = false;
  document.getElementById('autoBreakPrompt').classList.remove('active');
  _suppressCurrentAutoBreak();
  render();
}

// ── Break timer + UI ───────────────────────────────────────────────────────

export function updateBreakTimer() {
  if (!state.breakStartMs) return;
  const elapsedSec  = Math.floor((Date.now() - state.breakStartMs) / 1000);
  const elapsedMins = Math.floor(elapsedSec / 60);

  const timerEl  = document.getElementById('breakTimerDisplay');
  const statusEl = document.getElementById('breakStatus');
  const endBtn   = document.getElementById('endBreakBtn');
  const overlay  = document.getElementById('breakOverlay');
  const infoBar  = document.getElementById('breakInfoBar');
  const infoText = document.getElementById('breakInfoText');

  if (state.breakIsAuto) {
    const totalSec  = state.autoBreakMins * 60;
    const remainSec = Math.max(totalSec - elapsedSec, 0);
    const rm = Math.floor(remainSec / 60);
    const rs = remainSec % 60;
    const pct = Math.max(0, (remainSec / totalSec) * 100);

    if (timerEl)  { timerEl.textContent = `${rm}:${pad2(rs)}`; timerEl.classList.remove('over'); }
    if (statusEl) { statusEl.textContent = `${rm}:${pad2(rs)} remaining`; statusEl.classList.remove('over'); }
    if (endBtn)   endBtn.classList.remove('over');
    if (overlay)  overlay.classList.remove('over');
    if (infoBar)  { infoBar.style.width = pct + '%'; infoBar.classList.remove('over'); }
    if (infoText) { infoText.textContent = `${state.autoBreakMins - Math.floor(elapsedSec / 60)} min remaining`; infoText.classList.remove('over'); }

    if (remainSec === 0) { endBreak(); return; }
  } else {
    const s = elapsedSec % 60;
    const h = Math.floor(elapsedSec / 3600);
    const displayTime = h > 0
      ? `${h}:${pad2(elapsedMins % 60)}:${pad2(s)}`
      : `${elapsedMins}:${pad2(s)}`;

    const totalUsed   = state.breakUsedMins + elapsedMins;
    const over        = totalUsed >= state.breakBudgetMins;
    const remaining   = Math.max(state.breakBudgetMins - totalUsed, 0);
    const budgetLabel = fmtBudgetMins(state.breakBudgetMins);
    const pct         = Math.min((totalUsed / state.breakBudgetMins) * 100, 100);

    if (timerEl)  { timerEl.textContent = displayTime; timerEl.classList.toggle('over', over); }
    if (statusEl) {
      statusEl.textContent = over
        ? `${totalUsed - state.breakBudgetMins} min over your ${budgetLabel} daily budget`
        : `${remaining} min of ${budgetLabel} daily budget remaining`;
      statusEl.classList.toggle('over', over);
    }
    if (endBtn)   endBtn.classList.toggle('over', over);
    if (overlay)  overlay.classList.toggle('over', over);
    if (infoBar)  { infoBar.style.width = pct + '%'; infoBar.classList.toggle('over', over); }
    if (infoText) { infoText.textContent = `${totalUsed} min used of ${budgetLabel}`; infoText.classList.toggle('over', over); }
  }
}

export function endBreak() {
  if (!state.breakStartMs) return;

  const elapsedMins = Math.floor((Date.now() - state.breakStartMs) / 60000);
  state.breakUsedMins = (state.breakUsedMins || 0) + elapsedMins;
  state.breakDay      = todayPstDateStr();
  saveBreakState();

  const realBreakTask = state.breakTaskId
    ? state.tasks.find(t => t.id === state.breakTaskId && !t._ab)
    : null;
  if (realBreakTask) markDoneById(state.breakTaskId);

  if (state.breakTimerInt) { clearInterval(state.breakTimerInt); state.breakTimerInt = null; }
  state.breakStartMs = null;
  state.breakTaskId  = null;

  document.getElementById('breakOverlay').classList.remove('active');
  updateBreakUI();
  if (!realBreakTask) { save(); render(); }
}

export function computeBreakUsedMins() {
  const todayStr = getPST().toDateString();
  let mins = 0;
  for (const t of state.doneTasks) {
    if (!t.isBreak) continue;
    const donePst = new Date(new Date(t.doneAt).toLocaleString('en-US', { timeZone: state.timezone || 'America/Los_Angeles' }));
    if (donePst.toDateString() !== todayStr) continue;
    if (t.startTime && t.endTime) {
      const s = parseDateLocalMins(t.startTime);
      const e = parseDateLocalMins(t.endTime);
      if (e > s) mins += e - s;
    } else if (t.duration) {
      mins += t.duration;
    }
  }
  if (state.breakStartMs) mins += Math.floor((Date.now() - state.breakStartMs) / 60000);
  return mins;
}

export function updateBreakUI() {
  const totalUsed = computeBreakUsedMins();
  const over      = totalUsed > 0 && totalUsed >= state.breakBudgetMins;
  const pct       = state.breakBudgetMins > 0 ? Math.min((totalUsed / state.breakBudgetMins) * 100, 100) : 0;

  const tallyEl = document.getElementById('breakTally');
  if (tallyEl) {
    tallyEl.textContent = `${totalUsed} min used of ${fmtBudgetMins(state.breakBudgetMins)}`;
    tallyEl.classList.toggle('over', over);
  }
  const barFill = document.getElementById('breakBarFill');
  if (barFill) {
    barFill.style.width = pct + '%';
    barFill.classList.toggle('over', over);
  }
  const btn = document.getElementById('takeBreakBtn');
  if (btn) {
    btn.disabled = !!state.breakStartMs;
    btn.classList.toggle('over', over);
  }
}
