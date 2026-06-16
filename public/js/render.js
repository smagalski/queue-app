import { state } from './state.js';
import { DONE_TTL, DEFAULT_DUR, P_COLORS, P_LABELS, P_COLS, SCHED_COL, CAT_TALLY_COLORS } from './constants.js';
import { getPST, parseDateLocalMins, fmtTimePST, fmtEndTime, endTimeClass, fmtDuration, minsUntil, esc, pad2, fmtMins, timeAgo, msMinsToCalMins, todayPstDateStr } from './utils.js';
import { purgeDone, save } from './persistence.js';
import { getCategoryForTask, renderCategoryTally } from './categories.js';

// Hooks set by main.js to break circular deps
const _hooks = { renderCalendar: () => {}, updateBreakUI: () => {} };
export function setRenderHooks(hooks) { Object.assign(_hooks, hooks); }

// Module-local block detail state
let _detailBlock = null;
let _detailDp    = null;

// ── Auto-break helpers (moved here from breaks.js to break cycle) ──────────

export function removeAutoBreaks() {
  state.tasks = state.tasks.filter(t => !t._ab);
  const flex = state.tasks.filter(t => !isScheduled(t))
    .sort((a, b) => a.priority - b.priority
                 || (a.flexOrder ?? Infinity) - (b.flexOrder ?? Infinity)
                 || a.addedAt - b.addedAt);
  flex.forEach((t, i) => { t.flexOrder = i; });
}

export function applyAutoBreaks() {
  removeAutoBreaks();
  if (!state.autoBreakAfterTask) return;
  const flex = state.tasks.filter(t => !isScheduled(t))
    .sort((a, b) => a.priority - b.priority
                 || (a.flexOrder ?? Infinity) - (b.flexOrder ?? Infinity)
                 || a.addedAt - b.addedAt);
  const newFlex = [];
  let bIdx = 0;
  for (let i = 0; i < flex.length; i++) {
    let insertBreak = false;
    if (i === 0) {
      insertBreak = state.forceBreakBefore.has(flex[i].id)
                    && !flex[i].isBreak
                    && !state.suppressAutoBreakBefore.has(flex[i].id);
    } else {
      insertBreak = !flex[i].isBreak && !flex[i - 1].isBreak
                    && !state.suppressAutoBreakBefore.has(flex[i].id);
    }
    if (insertBreak) {
      newFlex.push({ id: -(++bIdx), title: 'Break', priority: 1,
        addedAt: Date.now(), duration: state.autoBreakMins, isBreak: true, _ab: true });
    }
    newFlex.push(flex[i]);
  }
  newFlex.forEach((t, i) => { t.flexOrder = i; });
  state.tasks = state.tasks.filter(t => isScheduled(t)).concat(newFlex);
}

// ── Task type helpers ──────────────────────────────────────────────────────

function effP(task) {
  if (!task.endTime) return { priority: task.priority, escalated: false };
  const mins = minsUntil(task.endTime);
  if (mins === null || mins < -60) return { priority: task.priority, escalated: false };
  if (mins <= 30) return { priority: 1, escalated: task.priority > 1 };
  if (mins <= 60) {
    const bumped = Math.max(1, task.priority - 1);
    return { priority: bumped, escalated: bumped < task.priority };
  }
  return { priority: task.priority, escalated: false };
}

export function isScheduled(t) {
  return t.type === 'scheduled' || (!t.type && (t.startTime || t.endTime));
}

export function getSorted() {
  return [...state.tasks]
    .filter(t => !isScheduled(t))
    .map(t => ({ ...t, _eff: effP(t), _active: true }))
    .sort((a, b) => {
      if (a._eff.priority !== b._eff.priority) return a._eff.priority - b._eff.priority;
      const ao = a.flexOrder !== undefined ? a.flexOrder : Infinity;
      const bo = b.flexOrder !== undefined ? b.flexOrder : Infinity;
      if (ao !== bo) return ao - bo;
      return a.addedAt - b.addedAt;
    });
}

export function getScheduled() {
  const pst     = getPST();
  const nowMins = pst.getHours() * 60 + pst.getMinutes();
  return [...state.tasks]
    .filter(t => isScheduled(t))
    .map(t => {
      const stMins = t.startTime ? parseDateLocalMins(t.startTime) : null;
      const dur    = t.duration || DEFAULT_DUR;
      const etMins = t.endTime  ? parseDateLocalMins(t.endTime)
                   : stMins != null ? stMins + dur : null;
      const active = stMins != null && nowMins >= stMins && (etMins == null || nowMins < etMins);
      return { ...t, _eff: { priority: 2, escalated: false }, _stMins: stMins, _etMins: etMins, _active: active };
    })
    .sort((a, b) => (a._stMins ?? 9999) - (b._stMins ?? 9999));
}

export function getAllSorted(flex) {
  if (!flex) flex = getSorted();
  const scheduled = getScheduled();
  const active    = scheduled.filter(t => t._active);
  const future    = scheduled.filter(t => !t._active);

  const pst  = getPST();
  let cursor = pst.getHours() * 60 + pst.getMinutes();
  for (const t of active) {
    if (t._etMins != null && t._etMins > cursor) cursor = t._etMins;
  }

  const flexQueue = [...flex];
  const result    = [];

  // The currently-active flex task (calStartTime set) must always stay before future
  // scheduled tasks — increasing its duration cannot displace it in the queue.
  if (flexQueue.length > 0 && flexQueue[0].calStartTime) {
    const [nowTask] = flexQueue.splice(0, 1);
    result.push(nowTask);
    const elapsedMins = Math.floor((Date.now() - nowTask.calStartTime) / 60000);
    const remaining   = Math.max(0, (nowTask.duration ?? DEFAULT_DUR) - elapsedMins);
    cursor += remaining;
  }

  for (const sched of future) {
    let i = 0;
    while (i < flexQueue.length) {
      const gap = (sched._stMins ?? cursor) - cursor;
      const dur = flexQueue[i].duration ?? DEFAULT_DUR;
      if (dur <= gap) {
        const [task] = flexQueue.splice(i, 1);
        result.push(task);
        cursor += dur;
      } else {
        i++;
      }
    }
    result.push(sched);
    if (sched._etMins != null && sched._etMins > cursor) cursor = sched._etMins;
  }

  result.push(...flexQueue);
  return [...active, ...result];
}

export function taskTimeLabel(task) {
  if (task.startTime && task.endTime) return `${fmtTimePST(task.startTime)} – ${fmtTimePST(task.endTime)}`;
  if (task.startTime) return `starts ${fmtTimePST(task.startTime)}`;
  if (task.endTime)   return fmtEndTime(task.endTime);
  if (task.calStartTime) return `started ${fmtTimePST(task.calStartTime)}`;
  return null;
}

function taskTimeClass(task) {
  if (task.endTime) return endTimeClass(task.endTime);
  return '';
}

// ── renderCard ─────────────────────────────────────────────────────────────

export function renderCard(task, opts) {
  opts = opts || {};
  if (!task) {
    const jokes = [
      'Climb a mountain','Run a marathon','Summit Everest','Complete a triathlon',
      'Hike the Pacific Crest Trail','Ski a black diamond','Surf a big wave',
      'Row across the ocean','Bike across the country','Free solo El Capitan',
      'Make a movie','Write a screenplay','Direct a short film','Win at Sundance',
      'Score a film','Edit a feature','Cast the perfect lead','Shoot on location',
      'Get a standing ovation','Land a distribution deal'
    ];
    const placeholder = jokes[Math.floor(Math.random() * jokes.length)];
    return `<div class="task-card empty" style="min-height:90px;border:1px dashed rgba(255,255,255,0.25);background:transparent;opacity:0.8;display:flex;align-items:center;justify-content:center"><span style="color:var(--text-dim);font-size:11px;font-style:italic;font-weight:400">${placeholder}</span></div>`;
  }
  const taskSched  = isScheduled(task);
  const taskBreak  = !!task.isBreak;
  const { priority, escalated } = task._eff;
  const col = taskBreak ? '#9863f3' : taskSched ? SCHED_COL : (P_COLORS[priority] || '#fff');

  const taskForLabel = (opts.slotIndex === 0 || opts.inMore) ? task : { ...task, calStartTime: null };
  const timeTxt = taskTimeLabel(taskForLabel);
  const _nowMins = getPST().getHours() * 60 + getPST().getMinutes();
  const timeCls = taskSched
    ? (task._etMins != null && task._etMins <= _nowMins ? 'end-over' : '')
    : taskTimeClass(task);

  const badgeHtml = taskBreak
    ? `<span class="priority-badge badge-break">Break</span>`
    : taskSched
    ? `<span class="priority-badge badge-sched" onclick="showSchedDropdown(${task.id},event)">⏰ SCHEDULED</span>`
    : `<span class="priority-badge pc-${priority}" onclick="showPriorityDropdown(${task.id},event)" style="cursor:pointer">${P_LABELS[priority]}</span>`;

  let catBadgeHtml = '';
  if (!taskBreak && state.categoryRules.length) {
    const catId  = getCategoryForTask(task.title, {}, task.id, task.categoryOverride);
    const catIdx = state.categoryRules.findIndex(r => r.id === catId);
    const catCol = CAT_TALLY_COLORS[catIdx >= 0 ? catIdx % CAT_TALLY_COLORS.length : 0];
    const catName = catIdx >= 0 ? state.categoryRules[catIdx].name : catId;
    catBadgeHtml = `<span class="priority-badge badge-cat" onclick="showCategoryDropdown(${task.id},event)">${esc(catName)}</span>`;
  }

  const escHtml     = escalated ? `<span class="escalation-badge">⚡ escalated</span>` : '';
  const carriedHtml = task.carriedFrom ? `<span class="carried-badge">↩ Carried</span>` : '';
  const hasCalStart = !taskSched && !!task.calStartTime && opts.slotIndex === 0;
  const timeHtml = timeTxt
    ? `<span class="time-display ${timeCls}"${
        taskSched   ? ` onclick="showSchedDropdown(${task.id},event)" style="cursor:pointer"`
        : hasCalStart ? ` onclick="showStartTimeDropdown(${task.id},event)" style="cursor:pointer"`
        : ''
      }>${esc(timeTxt)}</span>`
    : '';
  const durHtml = task.duration
    ? `<span class="duration-display" onclick="showDurDropdown(${task.id},event)" style="cursor:pointer;text-decoration:underline dotted">${fmtDuration(task.duration)}</span>`
    : `<span class="duration-display" onclick="showDurDropdown(${task.id},event)" style="cursor:pointer;opacity:0.4">+ duration</span>`;

  const dragAttrs = taskSched
    ? `onmousedown="schedDragAttempt(event,${task.id})"`
    : `draggable="true" ondragstart="cardDragStart(event,${task.id})" ondragend="cardDragEnd(event)"`;

  const moreAttrs = opts.inMore
    ? ` ondragover="moreCardDragOver(event,${task.id})" ondrop="moreCardDrop(event,${task.id})"`
    : '';

  const slotIdx = opts.slotIndex;
  const slotDropAttrs = (!taskSched && slotIdx !== undefined)
    ? ` ondragover="slotDragOver(event,${slotIdx})" ondrop="slotDrop(event,${slotIdx})"`
    : '';
  return `<div class="task-card ${taskSched ? 'sched-card' : 'flex-card'}" data-id="${task.id}" ${dragAttrs}${moreAttrs}${slotDropAttrs} style="--card-bar:${col};border-color:${col}" onclick="if(document.body.classList.contains('mobile-view')&&!event.target.closest('button'))openMobileTaskEdit(${task.id})">
    <button class="delete-btn" onclick="deleteTaskById(${task.id})" title="Delete">✕</button>
    <div class="card-task-title" ondblclick="startTitleEdit(${task.id},this)" style="cursor:text">${esc(task.title)}</div>
    <div class="task-meta" style="display:flex">${badgeHtml}${catBadgeHtml}${escHtml}${carriedHtml}${timeHtml}${durHtml}<button class="done-btn" onclick="markDoneById(${task.id})">✓ Done</button></div>
    ${taskSched ? '<div class="sched-error-msg">Scheduled tasks can\'t be reordered by priority.</div>' : ''}
  </div>`;
}

// ── Block detail modal ─────────────────────────────────────────────────────

export function openBlockDetail(b, dp) {
  _detailBlock = b;
  _detailDp    = dp;
  _renderBlockDetail();
  document.getElementById('blockDetailOverlay').classList.add('active');
}

export function closeBlockDetail() {
  document.getElementById('blockDetailOverlay').classList.remove('active');
  _detailBlock = null;
  _detailDp    = null;
}

function _minsToTimeInput(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function _renderBlockDetail() {
  const b = _detailBlock;
  if (!b) return;
  const task = b.task;
  const card = document.getElementById('blockDetailCard');
  if (!card) return;

  if (!b.done) {
    card.innerHTML = renderCard(task, { slotIndex: 0 });
  } else {
    const priority = task.priority || 3;
    const col = task.isBreak ? '#9863f3' : isScheduled(task) ? SCHED_COL : (P_COLORS[priority] || '#fff');
    const badgeHtml = task.isBreak
      ? `<span class="priority-badge badge-break">Break</span>`
      : isScheduled(task)
      ? `<span class="priority-badge badge-sched">⏰ Scheduled</span>`
      : `<span class="priority-badge pc-${priority}">${P_LABELS[priority]}</span>`;
    const durHtml = `<span class="duration-display">${fmtDuration(task.duration || DEFAULT_DUR)}</span>`;
    const doneCatBadge = (() => {
      if (task.isBreak || !state.categoryRules.length) return '';
      const catId  = getCategoryForTask(task.title, {}, task.id, task.categoryOverride);
      const catIdx = state.categoryRules.findIndex(r => r.id === catId);
      const catName = catIdx >= 0 ? state.categoryRules[catIdx].name : catId;
      return `<span class="priority-badge badge-cat" onclick="showCategoryDropdown(${task.id},event)">${esc(catName)}</span>`;
    })();
    card.innerHTML = `
      <div class="task-card ${isScheduled(task) ? 'sched-card' : 'flex-card'}" style="--card-bar:${col};border-color:${col};cursor:default">
        <div class="card-task-title" ondblclick="startDoneTitleEdit(${task.id},this)" style="cursor:text">${esc(task.title)}</div>
        <div class="task-meta" style="display:flex">${badgeHtml}${doneCatBadge}${durHtml}
          <span class="task-age" style="color:var(--done-color)">✓ Done</span>
        </div>
        <div class="block-detail-time-edit">
          <label>Start</label>
          <input type="time" id="bdStartTime" value="${_minsToTimeInput(b.startMins)}" onchange="updateDoneBlockTime()"/>
          <label>End</label>
          <input type="time" id="bdEndTime"   value="${_minsToTimeInput(b.endMins)}"   onchange="updateDoneBlockTime()"/>
        </div>
      </div>
      <div class="block-detail-delete-row">
        <button class="block-detail-delete-btn" onclick="deleteBlockFromDetail()">Delete</button>
      </div>`;
  }
}

export function deleteBlockFromDetail() {
  if (!_detailBlock) return;
  const task = _detailBlock.task;
  if (_detailBlock.done) {
    state.doneTasks = state.doneTasks.filter(t => t.id !== task.id);
  } else {
    state.tasks = state.tasks.filter(t => t.id !== task.id);
  }
  closeBlockDetail();
  save();
  render();
}

export function updateDoneBlockTime() {
  if (!_detailBlock || !_detailBlock.done || !_detailDp) return;
  const startVal = (document.getElementById('bdStartTime') || {}).value;
  const endVal   = (document.getElementById('bdEndTime')   || {}).value;
  if (!startVal || !endVal) return;
  if (startVal >= endVal) return;
  const doneTask = state.doneTasks.find(t => t.id === _detailBlock.task.id);
  if (!doneTask) return;
  doneTask.startTime = `${_detailDp}T${startVal}`;
  doneTask.endTime   = `${_detailDp}T${endVal}`;
  save();
  render();
}

function _refreshBlockDetail() {
  const overlay = document.getElementById('blockDetailOverlay');
  if (!overlay || !overlay.classList.contains('active') || !_detailBlock) return;
  if (_detailBlock.done) {
    const doneTask = state.doneTasks.find(t => t.id === _detailBlock.task.id);
    if (!doneTask) { closeBlockDetail(); return; }
    const startMins = doneTask.startTime ? parseDateLocalMins(doneTask.startTime) : _detailBlock.startMins;
    const endMins   = doneTask.endTime   ? parseDateLocalMins(doneTask.endTime)   : _detailBlock.endMins;
    _detailBlock = { ..._detailBlock, task: doneTask, startMins, endMins };
  } else {
    const task = state.tasks.find(t => t.id === _detailBlock.task.id);
    if (!task) { closeBlockDetail(); return; }
    task._eff = effP(task);
    _detailBlock = { ..._detailBlock, task };
  }
  _renderBlockDetail();
}

// ── render() ──────────────────────────────────────────────────────────────

export function render() {
  purgeDone();
  applyAutoBreaks();
  const flexSorted = getSorted();
  const all        = getAllSorted(flexSorted);

  // Stamp calStartTime only when the top FLEX task changes
  const topFlexId = flexSorted[0] ? flexSorted[0].id : null;
  if (topFlexId !== state.currentNowId) {
    if (state.currentNowId) {
      const prev = state.tasks.find(t => t.id === state.currentNowId);
      if (prev && !isScheduled(prev) && !prev._ab) {
        delete prev.calStartTime;
        save();
      }
    }
    state.currentNowId = topFlexId;
    if (topFlexId) {
      const taskObj = state.tasks.find(t => t.id === topFlexId);
      if (taskObj && !isScheduled(taskObj) && !taskObj._ab && !taskObj.calStartTime) {
        taskObj.calStartTime = Date.now();
        save();
      }
    }
  }

  // Reset stale calStartTime if the top task's stamp is from a previous PST day
  if (topFlexId) {
    const taskObj = state.tasks.find(t => t.id === topFlexId);
    if (taskObj && !isScheduled(taskObj) && !taskObj._ab && taskObj.calStartTime) {
      const _tz = state.timezone || 'America/Los_Angeles';
      const startDay = new Date(new Date(taskObj.calStartTime).toLocaleString('en-US', { timeZone: _tz })).toDateString();
      if (startDay !== getPST().toDateString()) {
        taskObj.calStartTime = Date.now();
        save();
      }
    }
  }

  // Show auto-break prompt when an _ab card reaches slot 0
  const topFlex = flexSorted[0];
  if (topFlex && topFlex._ab && topFlex.isBreak && !state.breakStartMs && !state.autoBreakPrompting) {
    state.autoBreakPrompting = true;
    const abpDur = document.getElementById('abpDuration');
    if (abpDur) abpDur.textContent = state.autoBreakMins;
    document.getElementById('autoBreakPrompt').classList.add('active');
  } else if (state.autoBreakPrompting && (!topFlex || !topFlex._ab)) {
    state.autoBreakPrompting = false;
    document.getElementById('autoBreakPrompt').classList.remove('active');
  }

  _hooks.renderCalendar();

  const realTaskCount = state.tasks.filter(t => !t.isBreak).length;
  document.getElementById('queueCount').textContent =
    realTaskCount === 0 ? 'empty' : `${realTaskCount} task${realTaskCount===1?'':'s'}`;

  const slotLabelIds = ['nowLabel','upnextLabel','deckLabel'];
  for (let i = 0; i < 3; i++) {
    const slot  = document.getElementById(`slot-${i}`);
    const label = document.getElementById(slotLabelIds[i]);
    const task  = all[i] || null;
    if (slot)  slot.innerHTML = renderCard(task, { slotIndex: i });
    if (label) label.style.color = task
      ? (isScheduled(task) ? SCHED_COL : (P_COLORS[task._eff.priority] || ''))
      : '';
  }

  const rest       = all.slice(3);
  const moreHeader = document.getElementById('moreHeader');
  const moreCards  = document.getElementById('moreCards');
  const moreCount  = document.getElementById('moreCount');
  if (moreHeader) moreHeader.style.display = rest.length > 0 ? '' : 'none';
  if (moreCount)  moreCount.textContent = rest.length > 0 ? `(${rest.length})` : '';
  if (moreCards)  moreCards.innerHTML   = rest.map(t => renderCard(t, { inMore: true })).join('');

  document.getElementById('doneList').innerHTML = state.doneTasks.length === 0
    ? '<div class="empty-queue">Nothing completed yet</div>'
    : state.doneTasks.map(t => `
        <div class="done-item">
          <span class="done-check">✓</span>
          <span class="done-title">${esc(t.title)}</span>
          <span class="done-age">${timeAgo(t.doneAt)}</span>
          <button class="undo-btn" onclick="unmarkDone(${t.id})">↩ Undo</button>
        </div>`).join('');

  const undoBtn = document.getElementById('titlebarUndoBtn');
  if (undoBtn) {
    undoBtn.disabled = state.doneTasks.length === 0;
    undoBtn.style.opacity = state.doneTasks.length === 0 ? '0.25' : '';
  }

  _hooks.updateBreakUI();
  _refreshBlockDetail();
  renderCategoryTally();
}

// ── Inline title editing for done tasks ───────────────────────────────────

export function startDoneTitleEdit(id, el) {
  const task = state.doneTasks.find(t => t.id === id);
  if (!task) return;
  const inp = document.createElement('input');
  inp.className = 'title-edit-input';
  inp.value = task.title;
  el.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v) task.title = v;
    const div = document.createElement('div');
    div.className = 'card-task-title';
    div.ondblclick = () => startDoneTitleEdit(id, div);
    div.style.cursor = 'text';
    div.textContent = task.title;
    inp.replaceWith(div);
    if (v) { save(); _refreshBlockDetail(); }
  };
  inp.addEventListener('blur', commit, { once: true });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = task.title; inp.blur(); } });
}
