import { state } from './state.js';
import { DEFAULT_DUR } from './constants.js';
import { getPST, todayPstDateStr, parseDateLocalMins, fmtMins, pad2, fmtDuration } from './utils.js';
import { save } from './persistence.js';
import { render, isScheduled, getSorted, getScheduled, taskTimeLabel, openBlockDetail } from './render.js';
import { renderCategoryTally } from './categories.js';

// ── Calendar helpers ───────────────────────────────────────────────────────

function minsToY(mins) {
  return (mins - state.calStart) * state.pxPerMin + 8;
}

function updatePxPerMin() {
  if (!document.body.classList.contains('mobile-view')) {
    const sec = document.querySelector('.calendar-section');
    if (sec) {
      const availH = sec.clientHeight - 24;
      const spanMins = state.calEnd - state.calStart;
      if (spanMins > 0 && availH > 50) {
        state.pxPerMin = Math.max(44 / 60, availH / spanMins);
      }
    }
  } else {
    state.pxPerMin = 44 / 60;
  }
}

function startCalTitleEdit(blockTask, isDone, spanEl) {
  const arr = isDone ? state.doneTasks : state.tasks;
  const task = arr.find(t => t.id === blockTask.id);
  if (!task || spanEl.querySelector('input')) return;
  const original = task.title;
  const input = document.createElement('input');
  input.style.cssText = 'background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.5);outline:none;color:inherit;font:inherit;width:100%;padding:0';
  input.value = original;
  spanEl.textContent = '';
  spanEl.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== original) {
      task.title = newTitle;
      delete task.categoryOverride;
      save();
    }
    renderCalendar();
    renderCategoryTally();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = original; input.blur(); }
  });
}

// ── renderCalendar ─────────────────────────────────────────────────────────

export function renderCalendar() {
  updatePxPerMin();
  const pst      = getPST();
  const todayStr = pst.toDateString();
  const nowMins  = pst.getHours() * 60 + pst.getMinutes();
  const dp       = todayPstDateStr();

  const blocks = [];

  const scheduledTasks = getScheduled();
  for (const task of scheduledTasks) {
    const dur = task.duration || DEFAULT_DUR;
    const startMins = task._stMins;
    const endMins   = task._etMins ?? (startMins != null ? startMins + dur : null);
    if (startMins == null) continue;
    blocks.push({ task, startMins, endMins, done: false, anchored: true, scheduled: true });
  }

  const occupied = [];

  for (const task of state.doneTasks) {
    const donePst = new Date(new Date(task.doneAt).toLocaleString('en-US', { timeZone: state.timezone || 'America/Los_Angeles' }));
    if (donePst.toDateString() !== todayStr) continue;

    let startMins, endMins;
    if (task.startTime && task.endTime) {
      startMins = parseDateLocalMins(task.startTime);
      endMins   = parseDateLocalMins(task.endTime);
    } else {
      const doneMins = donePst.getHours() * 60 + donePst.getMinutes();
      const dur      = task.duration || DEFAULT_DUR;
      startMins = doneMins - dur;
      endMins   = doneMins;
    }
    if (endMins <= startMins) continue;
    blocks.push({ task, startMins, endMins, done: true, anchored: false, scheduled: isScheduled(task) });
  }

  blocks.sort((a, b) => a.startMins - b.startMins || (b.anchored ? 1 : -1));
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const curr = blocks[i];
    if (curr.startMins < prev.endMins && !curr.anchored) {
      const dur = curr.endMins - curr.startMins;
      curr.startMins = prev.endMins;
      curr.endMins   = curr.startMins + dur;
    }
  }

  occupied.length = 0;
  for (const b of blocks) occupied.push({ start: b.startMins, end: b.endMins });

  function findGap(start, dur) {
    let cursor = start, safe = false;
    while (!safe) {
      safe = true;
      for (const w of occupied) {
        if (cursor < w.end && cursor + dur > w.start) {
          cursor = w.end; safe = false; break;
        }
      }
    }
    return cursor;
  }

  const flexTasks = getSorted();
  let cursor = findGap(nowMins, 1);
  for (const task of flexTasks) {
    const dur = task.duration || DEFAULT_DUR;
    let start, end;
    if (task.calStartTime && task.id === flexTasks[0].id) {
      const elapsedMins = (Date.now() - task.calStartTime) / 60000;
      const calStart = Math.round((new Date(new Date(task.calStartTime).toLocaleString('en-US',{timeZone: state.timezone || 'America/Los_Angeles'})).getHours()*60 + new Date(new Date(task.calStartTime).toLocaleString('en-US',{timeZone: state.timezone || 'America/Los_Angeles'})).getMinutes()));
      if (elapsedMins >= dur) {
        start = findGap(Math.max(state.calStart, nowMins - dur), dur);
        end   = start + dur;
      } else {
        start = calStart;
        end   = start + dur;
      }
    } else {
      start = findGap(cursor, dur);
      end   = start + dur;
    }
    blocks.push({ task, startMins: start, endMins: end, done: false, anchored: false, scheduled: false });
    cursor = end;
  }

  const container = document.getElementById('calContainer');
  container.style.height = ((state.calEnd - state.calStart) * state.pxPerMin + 24) + 'px';
  container.innerHTML = '';

  for (let h = Math.floor(state.calStart / 60); h <= Math.ceil(state.calEnd / 60); h++) {
    const y     = minsToY(h * 60);
    const label = h === 12 ? '12PM' : h > 12 ? `${h-12}PM` : `${h}AM`;
    const row   = document.createElement('div');
    row.className = 'cal-hour-row';
    row.style.top = y + 'px';
    row.innerHTML = `<span class="cal-hour-label">${label}</span><div class="cal-hour-line"></div>`;
    container.appendChild(row);
  }

  const track = document.createElement('div');
  track.className = 'cal-track';

  for (const b of blocks) {
    const yStart = minsToY(Math.max(b.startMins, state.calStart));
    const yEnd   = minsToY(Math.min(b.endMins,   state.calEnd));
    const height = Math.max(yEnd - yStart, 12);
    if (yStart > (state.calEnd - state.calStart) * state.pxPerMin + 8 || yEnd < 8) continue;

    const priority  = b.done ? b.task.priority : b.task._eff.priority;
    let   metaLabel = fmtDuration(b.task.duration || DEFAULT_DUR) || '';
    const tl        = taskTimeLabel(b.task);
    if (tl) metaLabel = tl;

    const block = document.createElement('div');
    const blockCls = b.task.isBreak
      ? `cal-block break-block${b.done ? ' done-block' : ''}`
      : b.scheduled
      ? `cal-block sched-block${b.done ? ' done-block' : ''}`
      : `cal-block pc-${priority}${b.done ? ' done-block' : ''}`;
    block.className = blockCls;
    block.style.top    = yStart + 'px';
    block.style.height = height + 'px';
    block.innerHTML    = `
      <span class="cal-block-title">${esc(b.task.title)}</span>
      <span class="cal-block-meta">${esc(metaLabel)}</span>`;

    const _titleSpan = block.querySelector('.cal-block-title');
    if (_titleSpan) {
      _titleSpan.addEventListener('dblclick', e => {
        e.stopPropagation();
        if (height >= 28) {
          startCalTitleEdit(b.task, b.done, _titleSpan);
        } else {
          openBlockDetail(b, dp);
        }
      });
    }
    block.addEventListener('dblclick', e => { e.stopPropagation(); openBlockDetail(b, dp); });

    if (b.scheduled && !b.done) {
      block.addEventListener('mousedown', e => { if (e.detail >= 2) return; startCalBlockDrag(e, b.task.id, b.startMins, b.endMins - b.startMins, dp); });
    } else if (b.done) {
      const topHandle = document.createElement('div');
      topHandle.className = 'cal-resize-handle cal-resize-top';
      const botHandle = document.createElement('div');
      botHandle.className = 'cal-resize-handle cal-resize-bot';
      if (height >= 20) {
        block.appendChild(topHandle);
        block.appendChild(botHandle);
      }

      const startDoneDrag = (e, mode) => {
        e.preventDefault(); e.stopPropagation();
        state.calDrag = { taskId: b.task.id, blockEl: block, startY: e.clientY,
                    origStartMins: b.startMins, origEndMins: b.endMins,
                    mode, isDone: true, dpStr: dp };
        block.classList.add('cal-dragging');
      };
      block.addEventListener('mousedown',  e => { if (e.detail >= 2 || e.target === topHandle || e.target === botHandle) return; startDoneDrag(e, 'move'); });
      topHandle.addEventListener('mousedown', e => startDoneDrag(e, 'resize-top'));
      botHandle.addEventListener('mousedown', e => startDoneDrag(e, 'resize-bot'));
    }
    track.appendChild(block);
  }

  container.appendChild(track);

  const nowLine = document.createElement('div');
  nowLine.className = 'cal-now-line';
  nowLine.id        = 'calNowLine';
  container.appendChild(nowLine);

  updateCalNowLine();
  if (!window._calScrolled) {
    document.getElementById('calendarSection').scrollTop = Math.max(0, minsToY(nowMins) - 44);
    window._calScrolled = true;
  }
}

export function updateCalNowLine() {
  const pst     = getPST();
  const nowMins = pst.getHours() * 60 + pst.getMinutes();
  const line    = document.getElementById('calNowLine');
  if (line) line.style.top = minsToY(nowMins) + 'px';
}

// ── Calendar bounds ────────────────────────────────────────────────────────

export function setCalBounds() {
  const startSel = document.getElementById('calStartSelect');
  const endSel   = document.getElementById('calEndSelect');
  if (!startSel || !endSel) return;
  const newStart = parseInt(startSel.value);
  const newEnd   = parseInt(endSel.value);
  const clampedEnd = newEnd <= newStart + 60 ? newStart + 60 : newEnd;
  if (clampedEnd !== newEnd) endSel.value = String(clampedEnd);
  state.calStart = newStart;
  state.calEnd   = clampedEnd;
  const uid = state.currentUser?.uid;
  localStorage.setItem(uid ? `q_calStart_${uid}` : 'q_calStart', String(state.calStart));
  localStorage.setItem(uid ? `q_calEnd_${uid}`   : 'q_calEnd',   String(state.calEnd));
  renderCalendar();
}

export function loadCalBounds() {
  const uid = state.currentUser?.uid;
  if (uid) {
    const s = localStorage.getItem(`q_calStart_${uid}`);
    const e = localStorage.getItem(`q_calEnd_${uid}`);
    if (s) state.calStart = parseInt(s);
    if (e) state.calEnd   = parseInt(e);
  }
  const startSel = document.getElementById('calStartSelect');
  const endSel   = document.getElementById('calEndSelect');
  if (startSel) startSel.value = String(state.calStart);
  if (endSel)   endSel.value   = String(state.calEnd);
}

// ── Calendar block drag ────────────────────────────────────────────────────

function startCalBlockDrag(e, taskId, startMins, dur, dpStr) {
  e.preventDefault();
  e.stopPropagation();
  const block = e.currentTarget;
  state.calDrag = { taskId, blockEl: block, startY: e.clientY,
              origStartMins: startMins, origEndMins: startMins + dur,
              mode: 'move', isDone: false, dpStr };
  block.classList.add('cal-dragging');
}

function calcDragTimes(dy) {
  const dMins = Math.round(dy / state.pxPerMin / 15) * 15;
  const { mode, origStartMins, origEndMins } = state.calDrag;
  if (mode === 'resize-top') {
    return { newStart: Math.max(state.calStart, Math.min(origEndMins - 15, origStartMins + dMins)), newEnd: origEndMins };
  } else if (mode === 'resize-bot') {
    return { newStart: origStartMins, newEnd: Math.max(origStartMins + 15, Math.min(state.calEnd, origEndMins + dMins)) };
  } else {
    const dur = origEndMins - origStartMins;
    const newStart = Math.max(state.calStart, Math.min(state.calEnd - dur, origStartMins + dMins));
    return { newStart, newEnd: newStart + dur };
  }
}

// Global mouse handlers — registered at module evaluation time
document.addEventListener('mousemove', e => {
  if (!state.calDrag) return;
  const { newStart, newEnd } = calcDragTimes(e.clientY - state.calDrag.startY);
  state.calDrag.blockEl.style.top    = minsToY(newStart) + 'px';
  state.calDrag.blockEl.style.height = Math.max(minsToY(newEnd) - minsToY(newStart), 12) + 'px';
  const meta = state.calDrag.blockEl.querySelector('.cal-block-meta');
  if (meta) {
    const fmt = m => { const h = Math.floor(m/60), mn = m%60, ap = h>=12?'pm':'am'; return `${h%12||12}:${pad2(mn)}${ap}`; };
    meta.textContent = state.calDrag.mode === 'move' ? fmt(newStart) : `${fmt(newStart)} – ${fmt(newEnd)}`;
  }
});

document.addEventListener('mouseup', e => {
  if (!state.calDrag) return;
  const { newStart, newEnd } = calcDragTimes(e.clientY - state.calDrag.startY);
  const { isDone, taskId, dpStr } = state.calDrag;
  const list = isDone ? state.doneTasks : state.tasks;
  const task = list.find(t => t.id === taskId);
  if (task) {
    task.startTime = `${dpStr}T${fmtMins(newStart)}`;
    task.endTime   = `${dpStr}T${fmtMins(newEnd)}`;
    if (isDone) task.duration = newEnd - newStart;
    save();
  }
  state.calDrag.blockEl.classList.remove('cal-dragging');
  state.calDrag = null;
  render();
});

// ── esc helper (local copy to avoid import cycle issues) ──────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
