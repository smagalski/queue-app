import { state } from './state.js';
import { DEFAULT_DUR, CAT_TALLY_COLORS } from './constants.js';
import { getPST, todayPstDateStr, parseDateLocalMins, fmtMins, pad2, msMinsToCalMins, esc } from './utils.js';
import { save, injectRecurringTasks } from './persistence.js';
import { render, isScheduled, getSorted, getAllSorted, closeBlockDetail } from './render.js';
import { getCategoryForTask, renderCategoryTally } from './categories.js';
import { getSmartTime, setSmartTime } from './utils.js';

// Hook for _afterAddFlexTask — set by main.js after sidequest.js imports
let _afterAddHook = () => {};
export function setAfterAddHook(fn) { _afterAddHook = fn; }

// ── Dropdown helpers ───────────────────────────────────────────────────────

function openDropdown(dd, rect, width) {
  dd.classList.add('open');
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  dd.style.top  = (rect.bottom + 4) + 'px';
  dd.style.left = left + 'px';
}

export function hideAllDropdowns() {
  hidePriorityDropdown();
  hideCategoryDropdown();
  hideSchedDropdown();
  hideDurDropdown();
  hideStartTimeDropdown();
}

// ── Priority dropdown ──────────────────────────────────────────────────────

export function showPriorityDropdown(taskId, event) {
  event.stopPropagation();
  state.pdTargetId = taskId;
  openDropdown(document.getElementById('priorityDropdown'), event.target.getBoundingClientRect(), 100);
}

export function changeTaskPriority(newP) {
  if (!state.pdTargetId) return;
  const task = state.tasks.find(t => t.id === state.pdTargetId);
  if (task) { task.priority = newP; save(); }
  hidePriorityDropdown();
  render();
}

function hidePriorityDropdown() {
  document.getElementById('priorityDropdown').classList.remove('open');
  state.pdTargetId = null;
}

// ── Category dropdown ──────────────────────────────────────────────────────

export function showCategoryDropdown(taskId, event) {
  event.stopPropagation();
  hideAllDropdowns();
  state.cdTargetId = taskId;
  const task = state.tasks.find(t => t.id === taskId) || state.doneTasks.find(t => t.id === taskId);
  const current = task ? getCategoryForTask(task.title, {}, task.id, task.categoryOverride) : null;
  const dd = document.getElementById('categoryDropdown');
  dd.innerHTML = state.categoryRules.map((cat, i) => {
    const isActive = cat.id === current;
    return `<button class="cat-dd-btn${isActive ? ' active' : ''}" onclick="changeTaskCategory('${cat.id}')">${esc(cat.name)}</button>`;
  }).join('');
  openDropdown(dd, event.target.getBoundingClientRect(), 150);
}

export function changeTaskCategory(catId) {
  if (!state.cdTargetId) return;
  const task = state.tasks.find(t => t.id === state.cdTargetId) || state.doneTasks.find(t => t.id === state.cdTargetId);
  if (task) { task.categoryOverride = catId; save(); }
  hideCategoryDropdown();
  render();
}

function hideCategoryDropdown() {
  document.getElementById('categoryDropdown').classList.remove('open');
  state.cdTargetId = null;
}

// ── Schedule-edit dropdown ─────────────────────────────────────────────────

export function showSchedDropdown(taskId, event) {
  event.stopPropagation();
  hideAllDropdowns();
  state.sdTargetId = taskId;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  const timeStr = task.startTime
    ? task.startTime.match(/T(\d{2}:\d{2})/)?.[1] ?? '09:00'
    : '09:00';
  sdSetAnchor('start');
  setSmartTime('sdTimeInput', timeStr);
  document.getElementById('sdDurInput').value = String(task.duration || DEFAULT_DUR);
  sdCheckSave();
  openDropdown(document.getElementById('schedDropdown'), event.target.getBoundingClientRect(), 218);
}

export function hideSchedDropdown() {
  document.getElementById('schedDropdown').classList.remove('open');
  state.sdTargetId = null;
}

export function sdSetAnchor(which) {
  state.sdAnchor = which;
  document.getElementById('sdAnchorStart').classList.toggle('active', which === 'start');
  document.getElementById('sdAnchorEnd').classList.toggle('active',   which === 'end');
}

export function sdCheckSave() {
  document.getElementById('sdSaveBtn').disabled = !getSmartTime('sdTimeInput');
}

export function commitSchedEdit() {
  if (!state.sdTargetId) return;
  const task = state.tasks.find(t => t.id === state.sdTargetId);
  if (!task) return;
  const timeVal = getSmartTime('sdTimeInput');
  if (!timeVal) return;
  const dur      = parseInt(document.getElementById('sdDurInput').value) || DEFAULT_DUR;
  const dp       = todayPstDateStr();
  const anchorDT = `${dp}T${timeVal}`;
  let startTime, endTime;
  if (state.sdAnchor === 'start') {
    startTime = anchorDT;
    endTime   = `${dp}T${fmtMins(parseDateLocalMins(anchorDT) + dur)}`;
  } else {
    endTime   = anchorDT;
    startTime = `${dp}T${fmtMins(parseDateLocalMins(anchorDT) - dur)}`;
  }
  task.type      = 'scheduled';
  task.startTime = startTime;
  task.endTime   = endTime;
  task.duration  = dur;
  delete task.priority;
  delete task.calStartTime;
  save();
  hideSchedDropdown();
  render();
}

export function convertToFlex() {
  if (!state.sdTargetId) return;
  const task = state.tasks.find(t => t.id === state.sdTargetId);
  if (!task) return;
  task.type     = 'flex';
  task.priority = task.priority || 3;
  delete task.startTime;
  delete task.endTime;
  delete task.calStartTime;
  save();
  hideSchedDropdown();
  render();
}

// ── Duration-edit dropdown ─────────────────────────────────────────────────

export function showDurDropdown(taskId, event) {
  event.stopPropagation();
  hideAllDropdowns();
  state.ddTargetId = taskId;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  document.getElementById('ddDurInput').value = String(task.duration || DEFAULT_DUR);
  openDropdown(document.getElementById('durDropdown'), event.target.getBoundingClientRect(), 168);
}

function hideDurDropdown() {
  document.getElementById('durDropdown').classList.remove('open');
  state.ddTargetId = null;
}

export function commitDurEdit() {
  if (!state.ddTargetId) return;
  const task = state.tasks.find(t => t.id === state.ddTargetId);
  if (!task) return;
  task.duration = parseInt(document.getElementById('ddDurInput').value) || DEFAULT_DUR;
  save();
  hideDurDropdown();
  render();
}

// ── Start-time-edit dropdown ───────────────────────────────────────────────

export function showStartTimeDropdown(taskId, event) {
  event.stopPropagation();
  hideAllDropdowns();
  state.stTargetId = taskId;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !task.calStartTime) return;
  const _tz = state.timezone || 'America/Los_Angeles';
  const p = new Date(new Date(task.calStartTime).toLocaleString('en-US', { timeZone: _tz }));
  document.getElementById('stTimeInput').value = `${pad2(p.getHours())}:${pad2(p.getMinutes())}`;
  openDropdown(document.getElementById('startTimeDropdown'), event.target.getBoundingClientRect(), 160);
}

function hideStartTimeDropdown() {
  document.getElementById('startTimeDropdown').classList.remove('open');
  state.stTargetId = null;
}

export function commitStartTimeEdit() {
  const timeVal = document.getElementById('stTimeInput').value;
  if (!timeVal || !state.stTargetId) { hideStartTimeDropdown(); return; }
  const task = state.tasks.find(t => t.id === state.stTargetId);
  if (!task) { hideStartTimeDropdown(); return; }
  const dp       = todayPstDateStr();
  const pstFake  = new Date(`${dp}T${timeVal}`);
  const offsetMs = Date.now() - getPST().getTime();
  task.calStartTime = pstFake.getTime() + offsetMs;
  hideStartTimeDropdown();
  save();
  render();
}

// ── Add form ───────────────────────────────────────────────────────────────

export function openAddForm() {
  closeSchedForm();
  state.addOpen = true;
  if (!state.selPriority) selectP(3);
  document.getElementById('addFormOverlay').classList.add('active');
  setTimeout(() => document.getElementById('taskInput').focus(), 80);
}

export function closeAddForm() {
  state.addOpen = false;
  document.getElementById('addFormOverlay').classList.remove('active');
  // Restore form if it was in sidequest mode
  const modal = document.getElementById('addFormInner');
  if (modal && modal.classList.contains('sidequest-mode')) {
    modal.classList.remove('sidequest-mode');
    const titleEl = modal.querySelector('.add-form-modal-title');
    if (titleEl) titleEl.textContent = 'Add Flex Task';
    const addBtn = document.getElementById('addBtn');
    if (addBtn) addBtn.textContent = 'Add Flex Task';
    const priorityRow = document.querySelector('.priority-group')?.parentElement;
    if (priorityRow) priorityRow.style.display = '';
  }
}

export function selectP(n) {
  state.selPriority = n;
  for (let i = 1; i <= 4; i++)
    document.getElementById(`pb${i}`).className = 'p-btn' + (i===n ? ` sel-${n}` : '');
  const modal = document.getElementById('addFormInner');
  const add   = document.getElementById('addBtn');
  const cls   = ['pcolor-1','pcolor-2','pcolor-3','pcolor-4'];
  cls.forEach(c => { modal.classList.remove(c); add.classList.remove(c); });
  if (n) { modal.classList.add(`pcolor-${n}`); add.classList.add(`pcolor-${n}`); }
  checkAdd();
}

export function checkAdd() {
  document.getElementById('addBtn').disabled =
    !(document.getElementById('taskInput').value.trim() && state.selPriority);
}

export function addTask() {
  const title = document.getElementById('taskInput').value.trim();
  if (!title || !state.selPriority) return;
  const durInp    = document.getElementById('durationInput');
  const flexOrder = state.tasks.filter(t => !isScheduled(t)).length;
  state.tasks.push({
    id: Date.now(), type: 'flex', title, priority: state.selPriority,
    addedAt: Date.now(), flexOrder,
    duration: parseInt(durInp.value) || DEFAULT_DUR,
  });
  document.getElementById('taskInput').value = '';
  durInp.value = '60';
  state.selPriority = null;
  for (let i = 1; i <= 4; i++) document.getElementById(`pb${i}`).className = 'p-btn';
  ['pcolor-1','pcolor-2','pcolor-3','pcolor-4'].forEach(c => {
    document.getElementById('addFormInner').classList.remove(c);
    document.getElementById('addBtn').classList.remove(c);
  });
  const newTask = state.tasks[state.tasks.length - 1];
  checkAdd();
  save(); closeAddForm();
  render();
  _afterAddHook(newTask);
}

// ── Scheduled task form ────────────────────────────────────────────────────

export function setAnchor(which) {
  state.schedAnchor = which;
  document.getElementById('anchorStartBtn').classList.toggle('sel-sched', which === 'start');
  document.getElementById('anchorEndBtn').classList.toggle('sel-sched',   which === 'end');
}

export function openSchedForm() {
  closeAddForm();
  state.schedOpen = true;
  if (!getSmartTime('schedTimeInput')) setSmartTime('schedTimeInput', '09:00');
  checkSchedAdd();
  document.getElementById('addSchedFormOverlay').classList.add('active');
  setTimeout(() => document.getElementById('schedTitleInput').focus(), 80);
}

export function closeSchedForm() {
  state.schedOpen = false;
  document.getElementById('addSchedFormOverlay').classList.remove('active');
}

export function checkSchedAdd() {
  const hasTitle    = document.getElementById('schedTitleInput').value.trim().length > 0;
  const hasTime     = getSmartTime('schedTimeInput').length > 0;
  const isRecurring = document.getElementById('schedRecurringCheck').checked;
  const hasDays     = !isRecurring || state.selectedRecurringDays.size > 0;
  document.getElementById('schedAddBtn').disabled = !(hasTitle && hasTime && hasDays);
}

export function toggleRecurringDays() {
  const checked = document.getElementById('schedRecurringCheck').checked;
  document.getElementById('schedDayPicker').classList.toggle('visible', checked);
  if (!checked) {
    state.selectedRecurringDays.clear();
    document.querySelectorAll('.recur-day-btn').forEach(b => b.classList.remove('active'));
  }
  checkSchedAdd();
}

export function toggleRecurringDay(day) {
  if (state.selectedRecurringDays.has(day)) {
    state.selectedRecurringDays.delete(day);
  } else {
    state.selectedRecurringDays.add(day);
  }
  document.querySelectorAll('.recur-day-btn').forEach(b => {
    b.classList.toggle('active', state.selectedRecurringDays.has(parseInt(b.dataset.day)));
  });
  checkSchedAdd();
}

export function addScheduledTask() {
  const title   = document.getElementById('schedTitleInput').value.trim();
  const timeVal = getSmartTime('schedTimeInput');
  if (!title || !timeVal) return;

  const dur      = parseInt(document.getElementById('schedDurInput').value) || DEFAULT_DUR;
  const dp       = todayPstDateStr();
  const anchorDT = `${dp}T${timeVal}`;

  let startTime, endTime;
  if (state.schedAnchor === 'start') {
    startTime = anchorDT;
    endTime   = `${dp}T${fmtMins(parseDateLocalMins(anchorDT) + dur)}`;
  } else {
    endTime   = anchorDT;
    startTime = `${dp}T${fmtMins(parseDateLocalMins(anchorDT) - dur)}`;
  }

  const isRecurring = document.getElementById('schedRecurringCheck').checked && state.selectedRecurringDays.size > 0;

  if (isRecurring) {
    state.recurringTasks.push({
      id: Date.now(), title, time: timeVal, anchor: state.schedAnchor,
      duration: dur, days: [...state.selectedRecurringDays].sort(), lastAddedDate: '',
    });
    injectRecurringTasks();
    const justAdded = state.recurringTasks[state.recurringTasks.length - 1];
    if (!justAdded.lastAddedDate) save();
  } else {
    state.tasks.push({
      id: Date.now(), type: 'scheduled', title, addedAt: Date.now(),
      startTime, endTime, duration: dur,
    });
    save();
  }

  document.getElementById('schedTitleInput').value = '';
  setSmartTime('schedTimeInput', '09:00');
  document.getElementById('schedDurInput').value   = '60';
  document.getElementById('schedRecurringCheck').checked = false;
  state.selectedRecurringDays.clear();
  document.getElementById('schedDayPicker').classList.remove('visible');
  document.querySelectorAll('.recur-day-btn').forEach(b => b.classList.remove('active'));
  setAnchor('start');
  checkSchedAdd();
  closeSchedForm();
  render();
}

// ── MORE toggle ────────────────────────────────────────────────────────────

export function toggleMore(e) {
  if (e) e.stopPropagation();
  state.moreOpen = !state.moreOpen;
  document.getElementById('moreCards').classList.toggle('open', state.moreOpen);
  document.getElementById('moreArrow').classList.toggle('open', state.moreOpen);
}

// ── Queue drag-and-drop ────────────────────────────────────────────────────

export function cardDragStart(e, id) {
  state.dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
  setTimeout(() => {
    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) card.classList.add('dragging');
  }, 0);
}

export function cardDragEnd(e) {
  state.dragId = null;
  document.querySelectorAll('.dragging').forEach(c => c.classList.remove('dragging'));
  document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  document.querySelectorAll('.more-drag-over').forEach(c => c.classList.remove('more-drag-over'));
}

export function schedDragAttempt(e, id) {
  const card = document.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const startX = e.clientX, startY = e.clientY;
  function onMove(me) {
    if (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!card.classList.contains('sched-drag-error')) {
        card.classList.add('sched-drag-error');
        setTimeout(() => card.classList.remove('sched-drag-error'), 2000);
      }
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

export function slotDragOver(e, slotIdx) {
  if (!state.dragId) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.card-slot, .more-cards').forEach(el => el.classList.remove('drag-over'));
  const slot = document.getElementById(`slot-${slotIdx}`);
  if (slot) slot.classList.add('drag-over');
}

export function slotDragLeave(e, slotIdx) {
  const slot = document.getElementById(`slot-${slotIdx}`);
  if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove('drag-over');
}

export function slotDrop(e, slotIdx) {
  e.preventDefault(); e.stopPropagation();
  if (!state.dragId) return;
  reorderFlexToAllIndex(state.dragId, slotIdx);
  state.dragId = null;
  render();
}

export function moreDragOver(e) {
  if (!state.dragId) return;
  e.preventDefault();
  if (!state.moreOpen) {
    state.moreOpen = true;
    document.getElementById('moreCards').classList.add('open');
    document.getElementById('moreArrow').classList.add('open');
  }
  document.querySelectorAll('.card-slot, .more-cards').forEach(el => el.classList.remove('drag-over'));
  document.getElementById('moreCards').classList.add('drag-over');
}

export function moreDragLeave(e) {
  const more = document.getElementById('moreCards');
  if (more && !more.contains(e.relatedTarget)) more.classList.remove('drag-over');
}

export function moreDrop(e) {
  e.preventDefault();
  if (!state.dragId) return;
  const draggedTask = state.tasks.find(t => t.id === state.dragId);
  if (draggedTask && !isScheduled(draggedTask)) {
    const maxOrder = getSorted().reduce((m, t) => Math.max(m, t.flexOrder ?? 0), 0);
    draggedTask.flexOrder = maxOrder + 1;
    save(); render();
  }
  state.dragId = null;
}

export function moreCardDragOver(e, targetId) {
  if (!state.dragId || state.dragId === targetId) return;
  e.preventDefault(); e.stopPropagation();
  document.getElementById('moreCards').classList.remove('drag-over');
  document.querySelectorAll('.more-cards .task-card').forEach(c => c.classList.remove('more-drag-over'));
  const target = document.querySelector(`.more-cards [data-id="${targetId}"]`);
  if (target) target.classList.add('more-drag-over');
}

export function moreCardDrop(e, targetId) {
  e.preventDefault(); e.stopPropagation();
  if (!state.dragId) return;
  const all = getAllSorted();
  const targetIdx = all.findIndex(t => t.id === targetId);
  if (targetIdx >= 0) reorderFlexToAllIndex(state.dragId, targetIdx);
  state.dragId = null;
  render();
}

function reorderFlexToAllIndex(draggedId, targetAllIndex) {
  const all       = getAllSorted();
  const flex      = getSorted();
  const displaced = all[targetAllIndex];
  const draggedTask = state.tasks.find(t => t.id === draggedId);
  if (!draggedTask || isScheduled(draggedTask)) return;

  if (!displaced) {
    draggedTask.flexOrder = flex.length;
    save(); return;
  }
  if (displaced.id === draggedId) return;

  if (isScheduled(displaced)) {
    for (let i = targetAllIndex + 1; i < all.length; i++) {
      if (!isScheduled(all[i])) return reorderFlexToAllIndex(draggedId, i);
    }
    return;
  }

  const targetFlexOrder = displaced.flexOrder ?? 0;
  for (const t of flex) {
    if (t.id === draggedId) continue;
    const task = state.tasks.find(x => x.id === t.id);
    if (task && (task.flexOrder ?? 0) >= targetFlexOrder) {
      task.flexOrder = (task.flexOrder ?? 0) + 1;
    }
  }
  draggedTask.flexOrder = targetFlexOrder;
  save();
}

// ── Delete / Done / Undo ───────────────────────────────────────────────────

export function deleteTaskById(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  save(); render();
}

export function markDoneById(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  const doneAt  = Date.now();
  const dp      = todayPstDateStr();
  const pst     = getPST();
  const nowMins = pst.getHours() * 60 + pst.getMinutes();

  if (isScheduled(task) && task.startTime) {
    task.endTime = `${dp}T${fmtMins(nowMins)}`;
  } else if (!isScheduled(task) && task.calStartTime) {
    task.startTime = `${dp}T${fmtMins(msMinsToCalMins(task.calStartTime))}`;
    task.endTime   = `${dp}T${fmtMins(nowMins)}`;
  }

  if (state.autoBreakAfterTask && !task.isBreak && !task._ab && !isScheduled(task)) {
    const nextFlex = state.tasks
      .filter(t => !isScheduled(t) && !t._ab && !t.isBreak)
      .sort((a, b) => a.priority - b.priority
                   || (a.flexOrder ?? Infinity) - (b.flexOrder ?? Infinity)
                   || a.addedAt - b.addedAt);
    if (nextFlex.length > 0) state.forceBreakBefore.add(nextFlex[0].id);
  }

  state.doneTasks.unshift({ ...task, doneAt });
  hideAllDropdowns();
  closeBlockDetail();
  save(); render();
}

export function unmarkDone(id) {
  const task = state.doneTasks.find(t => t.id === id);
  if (!task) return;
  state.doneTasks = state.doneTasks.filter(t => t.id !== id);
  const { doneAt, ...restored } = task;
  if (restored.type !== 'scheduled') {
    delete restored.startTime;
    delete restored.endTime;
    delete restored.calStartTime;
    if (restored.flexOrder === undefined) restored.flexOrder = getSorted().length;
  }
  state.tasks.push(restored);
  save(); render();
}

export function undoLastAction() {
  if (!state.doneTasks.length) return;
  unmarkDone(state.doneTasks[0].id);
}

export function toggleDone() {
  state.doneOpen = !state.doneOpen;
  document.getElementById('doneList').classList.toggle('open', state.doneOpen);
  document.getElementById('doneArrow').classList.toggle('open', state.doneOpen);
}

// ── Inline title editing ───────────────────────────────────────────────────

function _doTitleEdit(task, el, onCommit, cssText) {
  if (!task || el.querySelector('input')) return;
  const original = task.title;
  const card = cssText ? null : el.closest('.task-card');
  if (card) card.draggable = false;
  const input = document.createElement('input');
  if (cssText) input.style.cssText = cssText;
  else input.className = 'title-edit-input';
  input.value = original;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    if (card) card.draggable = true;
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== original) {
      task.title = newTitle;
      delete task.categoryOverride;
      save();
    }
    onCommit();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = original; input.blur(); }
  });
}

export function startTitleEdit(taskId, titleEl) {
  _doTitleEdit(state.tasks.find(t => t.id === taskId), titleEl, render, null);
}
