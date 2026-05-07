import { state } from './state.js';
import { DONE_TTL, DEFAULT_CATEGORY_RULES, RECUR_DAY_NAMES } from './constants.js';
import { todayPstDateStr, getPST, fmtMins, parseDateLocalMins, fmtTimePST, fmtTaskMins, esc } from './utils.js';

// Hooks registered by main.js to break circular deps with render/breaks/endday
const _hooks = {
  render: () => {},
  updateTodayHistory: () => {},
  updateBreakTimer: () => {},
  updateBreakUI: () => {},
};
export function registerPersistenceHooks(hooks) { Object.assign(_hooks, hooks); }

// ── Sync status ────────────────────────────────────────────────────────────

export function setSyncStatus(status) {
  const dot = document.getElementById('syncDot');
  const lbl = document.getElementById('syncLabel');
  if (!dot) return;
  dot.className = 'sync-dot ' + status;
  lbl.textContent = { synced: 'Synced', syncing: 'Saving…', error: 'Error', offline: 'Offline', connecting: 'Connecting…' }[status] || '';
}

// ── Persistence ────────────────────────────────────────────────────────────

export function save() {
  purgeDone();
  const saveTasks = state.tasks.filter(t => !t._ab);
  const uid = state.currentUser?.uid;
  if (uid) {
    try {
      localStorage.setItem(`q_tasks_${uid}`, JSON.stringify(saveTasks));
      localStorage.setItem(`q_done_${uid}`,  JSON.stringify(state.doneTasks));
    } catch(e) {}
  }
  _hooks.updateTodayHistory();
  if (state.stateDoc) {
    setSyncStatus('syncing');
    state.stateDoc.set({
      tasks: saveTasks,
      doneTasks: state.doneTasks,
      recurringTasks: state.recurringTasks,
      categoryRules: state.categoryRules,
      breakStartMs: state.breakStartMs || null,
      breakTaskId:  state.breakTaskId  || null,
    })
      .then(() => setSyncStatus('synced'))
      .catch(err => {
        console.error('[Queue] Save failed:', err);
        setSyncStatus('error');
        setTimeout(() => { if (state.currentUser) load(); }, 5000);
      });
  }
}

export function load() {
  const uid = state.currentUser?.uid;
  try { state.tasks     = JSON.parse(localStorage.getItem(uid ? `q_tasks_${uid}` : 'q_tasks') || '[]'); } catch(e){ state.tasks=[]; }
  try { state.doneTasks = JSON.parse(localStorage.getItem(uid ? `q_done_${uid}`  : 'q_done')  || '[]'); } catch(e){ state.doneTasks=[]; }
  purgeDone();
  _hooks.render();

  if (!state.stateDoc) {
    setSyncStatus('offline');
    document.getElementById('syncLabel').textContent = 'Local only';
    return;
  }
  setSyncStatus('connecting');
  if (state.unsubscribeSnapshot) state.unsubscribeSnapshot();
  state.unsubscribeSnapshot = state.stateDoc.onSnapshot(snap => {
    if (!snap.exists) {
      state.tasks = []; state.doneTasks = []; state.recurringTasks = [];
      setSyncStatus('synced'); _hooks.render(); return;
    }
    const data = snap.data();
    state.tasks          = data.tasks          || [];
    state.doneTasks      = data.doneTasks      || [];
    state.recurringTasks = data.recurringTasks || [];
    state.categoryRules  = data.categoryRules  || [];
    if (!state.categoryRules.length) {
      state.categoryRules = JSON.parse(JSON.stringify(DEFAULT_CATEGORY_RULES));
      setTimeout(() => save(), 0);
    }
    purgeDone();
    try {
      localStorage.setItem('q_tasks', JSON.stringify(state.tasks));
      localStorage.setItem('q_done',  JSON.stringify(state.doneTasks));
    } catch(e) {}
    injectRecurringTasks();
    setSyncStatus('synced');
    _hooks.render();

    // Sync break overlay from Firestore (works on refresh + cross-window)
    const breakTask = state.tasks.find(t => t.isBreak && !t._ab);
    if (breakTask && !state.breakStartMs) {
      state.breakStartMs = data.breakStartMs || breakTask.calStartTime || breakTask.addedAt;
      state.breakTaskId  = breakTask.id;
      state.breakIsAuto  = false;
      const badge = document.getElementById('breakTypeBadge');
      if (badge) badge.textContent = 'Manual';
      document.getElementById('breakOverlay').classList.add('active');
      if (!state.breakTimerInt) {
        _hooks.updateBreakTimer();
        state.breakTimerInt = setInterval(_hooks.updateBreakTimer, 1000);
      }
    } else if (!breakTask && state.breakStartMs) {
      state.breakStartMs = null;
      state.breakTaskId  = null;
      if (state.breakTimerInt) { clearInterval(state.breakTimerInt); state.breakTimerInt = null; }
      document.getElementById('breakOverlay').classList.remove('active');
      _hooks.updateBreakUI();
    }
  }, err => {
    console.error('[Queue] Firestore listener error:', err);
    setSyncStatus('error');
    if (state.listenerRetryTimer) clearTimeout(state.listenerRetryTimer);
    state.listenerRetryTimer = setTimeout(() => {
      state.listenerRetryTimer = null;
      if (state.currentUser && state.stateDoc) load();
    }, 5000);
  });
}

// ── Recurring task injection ───────────────────────────────────────────────

export function injectRecurringTasks() {
  if (!state.recurringTasks.length) return;
  const today     = todayPstDateStr();
  const dayOfWeek = getPST().getDay();
  let injected    = false;
  state.recurringTasks.forEach((rt, i) => {
    if (rt.days.includes(dayOfWeek) && rt.lastAddedDate !== today) {
      const anchorDT = `${today}T${rt.time}`;
      const dur      = rt.duration;
      let startTime, endTime;
      if (rt.anchor === 'start') {
        startTime = anchorDT;
        endTime   = `${today}T${fmtMins(parseDateLocalMins(anchorDT) + dur)}`;
      } else {
        endTime   = anchorDT;
        startTime = `${today}T${fmtMins(parseDateLocalMins(anchorDT) - dur)}`;
      }
      state.tasks.push({
        id: Date.now() + i * 1000 + Math.floor(Math.random() * 1000),
        type: 'scheduled',
        title: rt.title,
        addedAt: Date.now(),
        startTime, endTime, duration: dur,
        recurringId: rt.id,
      });
      rt.lastAddedDate = today;
      injected = true;
    }
  });
  if (injected) save();
}

// ── Recurring tasks modal ──────────────────────────────────────────────────

export function openRecurringOverlay() {
  renderRecurringList();
  document.getElementById('recurringOverlay').classList.add('active');
}

export function closeRecurringOverlay() {
  document.getElementById('recurringOverlay').classList.remove('active');
}

export function deleteRecurring(id) {
  state.recurringTasks = state.recurringTasks.filter(rt => rt.id !== id);
  save();
  renderRecurringList();
}

export function renderRecurringList() {
  const body = document.getElementById('recurringBody');
  if (!state.recurringTasks.length) {
    body.innerHTML = '<div class="recur-empty">No recurring tasks yet.<br>Create one by checking "Repeat weekly" when adding a scheduled task.</div>';
    return;
  }
  body.innerHTML = state.recurringTasks.map(rt => {
    const timeLabel = `${rt.anchor === 'start' ? 'Starts' : 'Ends'} at ${fmtTimePST('T' + rt.time)}`;
    const durLabel  = fmtTaskMins(rt.duration);
    const dayChips  = RECUR_DAY_NAMES.map((d, i) =>
      `<span class="recur-day-chip${rt.days.includes(i) ? ' on' : ''}">${d}</span>`
    ).join('');
    return `<div class="recur-task-card">
      <div class="recur-task-header">
        <div class="recur-task-title">${rt.title}</div>
        <div class="recur-card-actions">
          <button class="recur-edit-btn" onclick="openEditRecurring(${rt.id})">Edit</button>
          <button class="recur-delete-btn" onclick="deleteRecurring(${rt.id})">Delete</button>
        </div>
      </div>
      <div class="recur-task-meta">${timeLabel} · ${durLabel}</div>
      <div class="recur-task-days">${dayChips}</div>
    </div>`;
  }).join('');
}

// ── Recurring task editing ─────────────────────────────────────────────────

let _editingRtId = null;

const DURATION_OPTS = [
  [15,'15 min'],[30,'30 min'],[45,'45 min'],[60,'1 hr'],
  [90,'1 hr 30 min'],[120,'2 hr'],[150,'2 hr 30 min'],[180,'3 hr'],
  [240,'4 hr'],[300,'5 hr'],[360,'6 hr'],[480,'8 hr'],
];

export function openEditRecurring(id) {
  _editingRtId = id;
  const rt = state.recurringTasks.find(r => r.id === id);
  if (!rt) return;

  const durOptions = DURATION_OPTS.map(([v, l]) =>
    `<option value="${v}"${v === rt.duration ? ' selected' : ''}>${l}</option>`
  ).join('');

  const dayBtns = RECUR_DAY_NAMES.map((d, i) =>
    `<button type="button" class="recur-day-btn rte-day-btn${rt.days.includes(i) ? ' active' : ''}" data-day="${i}"
      onclick="this.classList.toggle('active')">${d}</button>`
  ).join('');

  document.getElementById('recurringBody').innerHTML = `
    <div class="recur-edit-panel">
      <div class="recur-edit-row">
        <label class="form-label">Name</label>
        <input class="task-input" id="rteTitle" value="${esc(rt.title)}" maxlength="120"
               onkeydown="if(event.key==='Enter')saveEditRecurring();if(event.key==='Escape')cancelEditRecurring()"/>
      </div>
      <div class="recur-edit-row recur-edit-time-row">
        <div class="recur-edit-col">
          <label class="form-label">Time</label>
          <input class="task-input rte-time-input" id="rteTime" type="time" value="${rt.time}"/>
        </div>
        <div class="recur-edit-col">
          <label class="form-label">Anchor</label>
          <div style="display:flex;gap:5px">
            <button type="button" id="rteAnchorStart" class="p-btn rte-anchor-btn${rt.anchor === 'start' ? ' sel-sched' : ''}" data-anchor="start"
              onclick="document.querySelectorAll('.rte-anchor-btn').forEach(b=>b.classList.remove('sel-sched'));this.classList.add('sel-sched')">Start</button>
            <button type="button" id="rteAnchorEnd" class="p-btn rte-anchor-btn${rt.anchor === 'end' ? ' sel-sched' : ''}"
              onclick="document.querySelectorAll('.rte-anchor-btn').forEach(b=>b.classList.remove('sel-sched'));this.classList.add('sel-sched')"
              data-anchor="end">End</button>
          </div>
        </div>
        <div class="recur-edit-col">
          <label class="form-label">Duration</label>
          <select class="duration-select" id="rteDuration">${durOptions}</select>
        </div>
      </div>
      <div class="recur-edit-row">
        <label class="form-label">Days</label>
        <div class="recur-day-picker" style="display:flex">${dayBtns}</div>
      </div>
      <div class="recur-edit-footer">
        <button class="recur-delete-btn" onclick="cancelEditRecurring()">Cancel</button>
        <button class="add-sched-btn" style="flex:1" onclick="saveEditRecurring()">Save Changes</button>
      </div>
    </div>`;
}

export function cancelEditRecurring() {
  _editingRtId = null;
  renderRecurringList();
}

export function saveEditRecurring() {
  const id = _editingRtId;
  if (!id) return;
  const rt = state.recurringTasks.find(r => r.id === id);
  if (!rt) return;

  const title    = document.getElementById('rteTitle')?.value.trim();
  const time     = document.getElementById('rteTime')?.value;        // "HH:MM"
  const duration = parseInt(document.getElementById('rteDuration')?.value);
  const days     = [...document.querySelectorAll('.rte-day-btn.active')].map(b => parseInt(b.dataset.day)).sort((a,b) => a-b);
  const anchorEl = document.querySelector('.rte-anchor-btn.sel-sched');
  const anchor   = anchorEl?.dataset.anchor || rt.anchor;

  if (!title || !time || isNaN(duration) || !days.length) return;

  rt.title    = title;
  rt.time     = time;
  rt.anchor   = anchor;
  rt.duration = duration;
  rt.days     = days;

  _editingRtId = null;
  save();
  renderRecurringList();
}

// ── purgeDone ──────────────────────────────────────────────────────────────

export function purgeDone() {
  state.doneTasks = state.doneTasks.filter(t => (Date.now() - t.doneAt) < DONE_TTL);
}
