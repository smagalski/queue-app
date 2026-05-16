import { state } from './state.js';
import { DEFAULT_DUR } from './constants.js';
import { getPST, todayPstDateStr, fmtMins, msMinsToCalMins } from './utils.js';
import { save } from './persistence.js';
import { render, isScheduled } from './render.js';
import { markDoneById, openAddForm } from './taskactions.js';

// Module-local state
let _sqStartMs    = null;
let _sqTimerInt   = null;
let _sqPausedTask = null;
let _sqTaskId     = null;
let _sqPending    = false;

// Captured at openSidequest() before addTask/render can disturb state
let _sqInterruptedId       = null;
let _sqInterruptedCalStart = null;

export function openSidequest() {
  _sqPending = true;
  // Snapshot the current NOW task before the add-form opens and render() runs
  const curId   = state.currentNowId;
  const curTask = curId ? state.tasks.find(t => t.id === curId && !isScheduled(t) && !t._ab) : null;
  _sqInterruptedId       = curTask ? curTask.id           : null;
  _sqInterruptedCalStart = curTask ? curTask.calStartTime : null;
  openAddForm();
  // Style the form for sidequest context — priority is irrelevant since the task becomes scheduled
  const modal = document.getElementById('addFormInner');
  if (modal) {
    modal.classList.add('sidequest-mode');
    const titleEl = modal.querySelector('.add-form-modal-title');
    if (titleEl) titleEl.textContent = 'Add Sidequest';
    const addBtn = document.getElementById('addBtn');
    if (addBtn) addBtn.textContent = 'Start Sidequest';
    const priorityRow = document.querySelector('.priority-group')?.parentElement;
    if (priorityRow) priorityRow.style.display = 'none';
  }
}

// Called from main.js via setAfterAddHook — triggers after a flex task is added
export function _afterAddFlexTask(newTask) {
  if (!_sqPending) return;
  _sqPending = false;
  _startSidequest(newTask);
}

function _startSidequest(sqTask) {
  const pst      = getPST();
  const nowMins  = pst.getHours() * 60 + pst.getMinutes();
  const dp       = todayPstDateStr();
  const startIso = `${dp}T${fmtMins(nowMins)}`;

  // Use the id captured at openSidequest() — immune to render() calls during addTask()
  const nowTask = (_sqInterruptedId && _sqInterruptedId !== sqTask.id)
    ? state.tasks.find(t => t.id === _sqInterruptedId)
    : null;

  if (nowTask) {
    state.tasks = state.tasks.filter(t => t.id !== nowTask.id);
    const doneEntry = { ...nowTask, doneAt: Date.now() };
    delete doneEntry._eff; delete doneEntry._stMins; delete doneEntry._etMins; delete doneEntry._active;
    const calStart = _sqInterruptedCalStart || nowTask.calStartTime;
    if (!isScheduled(nowTask) && calStart) {
      doneEntry.startTime = `${dp}T${fmtMins(msMinsToCalMins(calStart))}`;
      doneEntry.endTime   = startIso;
    } else if (isScheduled(nowTask) && nowTask.startTime) {
      doneEntry.endTime = startIso;
    }
    state.doneTasks.unshift(doneEntry);
    _sqPausedTask = nowTask;
  } else {
    _sqPausedTask = null;
  }

  state.tasks.forEach(t => {
    if (!isScheduled(t) && t.flexOrder !== undefined && t.id !== sqTask.id) t.flexOrder += 1;
  });

  const sq = state.tasks.find(t => t.id === sqTask.id);
  if (sq) {
    sq.type      = 'scheduled';
    sq.startTime = startIso;
    delete sq.flexOrder;
    delete sq.isSidequest;
    _sqTaskId = sq.id;
  }

  if (_sqPausedTask) {
    const calStart = _sqInterruptedCalStart || _sqPausedTask.calStartTime;
    let remaining  = _sqPausedTask.duration || DEFAULT_DUR;
    if (!isScheduled(_sqPausedTask) && calStart) {
      const elapsed = Math.floor((Date.now() - calStart) / 60000);
      remaining = Math.max((_sqPausedTask.duration || DEFAULT_DUR) - elapsed, 1);
    }
    _sqPausedTask._sqRemaining = remaining;
  }

  _sqInterruptedId       = null;
  _sqInterruptedCalStart = null;

  _sqStartMs = Date.now();
  save(); render();

  document.getElementById('sqTaskTitle').textContent = sqTask.title;
  const pausedEl = document.getElementById('sqPausedTask');
  if (pausedEl) {
    pausedEl.textContent    = _sqPausedTask ? `Paused: ${_sqPausedTask.title}` : '';
    pausedEl.style.display  = _sqPausedTask ? '' : 'none';
  }
  _updateSqTimer();
  document.getElementById('sidequestOverlay').classList.add('active');
  _sqTimerInt = setInterval(_updateSqTimer, 1000);
}

function _updateSqTimer() {
  if (!_sqStartMs) return;
  const secs = Math.floor((Date.now() - _sqStartMs) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  document.getElementById('sqTimerDisplay').textContent = `${m}:${String(s).padStart(2,'0')}`;
}

export function endSidequest() {
  if (_sqTimerInt) { clearInterval(_sqTimerInt); _sqTimerInt = null; }
  document.getElementById('sidequestOverlay').classList.remove('active');

  const pst     = getPST();
  const nowMins = pst.getHours() * 60 + pst.getMinutes();
  const dp      = todayPstDateStr();
  const sqTask  = _sqTaskId ? state.tasks.find(t => t.id === _sqTaskId) : null;
  if (sqTask) sqTask.endTime = `${dp}T${fmtMins(nowMins)}`;

  if (_sqPausedTask) {
    state.tasks.forEach(t => {
      if (!isScheduled(t) && t.flexOrder !== undefined) t.flexOrder += 1;
    });
    const resumeTask = {
      ..._sqPausedTask,
      id:        Date.now() + 1,
      flexOrder: 0,
      duration:  _sqPausedTask._sqRemaining || _sqPausedTask.duration || DEFAULT_DUR,
      addedAt:   Date.now() + 1,
    };
    delete resumeTask._eff; delete resumeTask._stMins; delete resumeTask._etMins;
    delete resumeTask._active; delete resumeTask.calStartTime;
    delete resumeTask.startTime; delete resumeTask.endTime;
    delete resumeTask.doneAt; delete resumeTask._sqRemaining;
    state.tasks.push(resumeTask);
  }

  _sqStartMs    = null;
  _sqPausedTask = null;
  _sqTaskId     = null;

  if (sqTask) markDoneById(sqTask.id);
  else { save(); render(); }
}
