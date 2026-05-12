import { state } from './state.js';
import { DEFAULT_CATEGORY_RULES } from './constants.js';
import { todayPstDateStr, getPST, parseDateLocalMins, fmtTimePST, fmtMins, pad2, esc } from './utils.js';
import { save } from './persistence.js';
import { getCategoryForTask } from './categories.js';
import { prevDateStr, computeStreak, renderStreak, getStreakCount, refreshStreak } from './streak.js';

let _wup = null;

function _wupFmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export async function checkPreviousDayWrapUp() {
  if (!state.db || !state.currentUser) return;
  const today = todayPstDateStr();
  const wrapKey = `q_wrapup_prompt_date_${state.currentUser.uid}`;
  if (localStorage.getItem(wrapKey) === today) return;
  // Run in parallel so streak cache is warm before openWrapUpPrompt calls getStreakCount()
  const [incomplete] = await Promise.all([
    getIncompletePastDays(),
    computeStreak().then(renderStreak),
  ]);
  if (!incomplete.length) return;
  openWrapUpPrompt(incomplete);
}

async function getIncompletePastDays() {
  if (!state.db || !state.currentUser) return [];
  const today = todayPstDateStr();
  const [ty, tm, td] = today.split('-').map(Number);
  const cutoffDt = new Date(ty, tm - 1, td);
  cutoffDt.setDate(cutoffDt.getDate() - 14);
  const cutoff = `${cutoffDt.getFullYear()}-${pad2(cutoffDt.getMonth() + 1)}-${pad2(cutoffDt.getDate())}`;
  try {
    const snap = await state.db.collection('users').doc(state.currentUser.uid).collection('history')
      .orderBy('date', 'desc').limit(30).get();
    const incomplete = [];
    const seenDates  = new Set();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!data.date || data.date >= today || data.date < cutoff) continue;
      seenDates.add(data.date);
      if (data.dayEnded || data.dayOff || data.dayNotTracked || data.wrapUpCompleted) continue;
      incomplete.push({ date: data.date, doc: data });
    }
    const yesterday = prevDateStr(today);
    if (snap.docs.length > 0 && yesterday >= cutoff && !seenDates.has(yesterday)) {
      incomplete.unshift({ date: yesterday, doc: null });
    }
    incomplete.sort((a, b) => b.date.localeCompare(a.date));
    return incomplete;
  } catch(e) {
    console.error('[Queue] Wrap-up check failed:', e);
    return [];
  }
}

function openWrapUpPrompt(incompleteDays) {
  const newest  = incompleteDays[0];
  const hasDoc  = newest.doc !== null;
  const eyebrow = document.getElementById('wupPromptEyebrow');
  const actions = document.getElementById('wupPromptActions');
  eyebrow.textContent = _wupFmtDate(newest.date).toUpperCase();
  const streak = getStreakCount();
  const streakLine = streak > 0
    ? `<p class="wup-streak-note">You have a <strong>${streak}-day streak</strong> — finishing this day keeps it going.</p>`
    : '';
  actions.innerHTML = `
    ${streakLine}
    <button class="wup-btn-primary" onclick="openWrapUpWizard()">Yes, let's wrap up</button>
    <button class="wup-btn-secondary" onclick="markDayResolvedFromPrompt('dayOff')">Mark as Day Off</button>
    <button class="wup-btn-secondary" onclick="markDayResolvedFromPrompt('dayNotTracked')">Workday (not tracked)</button>
    <button class="wup-btn-ghost" style="text-align:left" onclick="closeWrapUpPrompt()">Maybe later</button>
  `;
  const overlay = document.getElementById('wupPromptOverlay');
  overlay._incompleteDays = incompleteDays;
  overlay.classList.add('active');
}

export function closeWrapUpPrompt() {
  document.getElementById('wupPromptOverlay').classList.remove('active');
}

export function markDayResolvedFromPrompt(type) {
  const overlay = document.getElementById('wupPromptOverlay');
  const days = overlay._incompleteDays || [];
  if (!days.length) return;
  markDayResolved(days[0].date, type);
  if (state.currentUser) localStorage.setItem(`q_wrapup_prompt_date_${state.currentUser.uid}`, todayPstDateStr());
  overlay.classList.remove('active');
}

function markDayResolved(date, type) {
  if (!state.db || !state.currentUser) return;
  state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(date)
    .set({ date, [type]: true, savedAt: Date.now() }, { merge: true })
    .catch(err => console.error('[Queue] markDayResolved failed:', err));
}

export function openWrapUpWizard() {
  const promptOverlay = document.getElementById('wupPromptOverlay');
  const incompleteDays = promptOverlay._incompleteDays || [];
  if (!incompleteDays.length) return;
  promptOverlay.classList.remove('active');
  if (state.currentUser) localStorage.setItem(`q_wrapup_prompt_date_${state.currentUser.uid}`, todayPstDateStr());
  const newest    = incompleteDays[0];
  const olderDays = incompleteDays.slice(1);
  _wup = {
    date:        newest.date,
    historyDoc:  newest.doc,
    steps:       buildWizardSteps(newest.doc, olderDays),
    stepIdx:     0,
    taskAnswers: {},
    addedTasks:  [],
    addFormOpen: false,
  };
  document.getElementById('wupTimelineDate').textContent = _wupFmtDate(_wup.date);
  renderWrapUpTimeline();
  renderWupStep();
  document.getElementById('wupOverlay').classList.add('active');
}

function buildWizardSteps(historyDoc, olderDays) {
  const steps = [];
  for (const od of [...olderDays].reverse()) {
    steps.push({ type: 'older-day', date: od.date });
  }
  const incomplete = (historyDoc && historyDoc.incompleteTasks) ? historyDoc.incompleteTasks : [];
  for (const task of incomplete) {
    steps.push({ type: 'task', task });
  }
  steps.push({ type: 'add-tasks', allCompleted: historyDoc !== null && incomplete.length === 0 });
  steps.push({ type: 'confirm' });
  return steps;
}

function renderWupStep() {
  if (!_wup) return;
  const step  = _wup.steps[_wup.stepIdx];
  const total = _wup.steps.length;
  document.getElementById('wupProgress').textContent = `Step ${_wup.stepIdx + 1} of ${total}`;
  const body = document.getElementById('wupStepBody');
  const nav  = document.getElementById('wupNav');
  body.innerHTML = '';
  nav.innerHTML  = '';
  const backBtn = `<button class="wup-btn-ghost wup-nav-back" onclick="_wupGoBack()">← Back</button>`;

  switch (step.type) {
    case 'older-day': {
      body.innerHTML = `
        <div class="wup-step-eyebrow">UNRESOLVED DAY</div>
        <div class="wup-step-heading">${esc(_wupFmtDate(step.date))}</div>
        <div class="wup-step-sub">This day has no recorded activity. How would you like to mark it?</div>
        <div class="wup-step-choices">
          <button class="wup-choice-btn wup-choice-yes" onclick="_wupResolveOlderDay('dayOff')">Day Off</button>
          <button class="wup-choice-btn" onclick="_wupResolveOlderDay('dayNotTracked')">Workday (not tracked)</button>
          <button class="wup-choice-btn wup-choice-skip" onclick="_wupResolveOlderDay('skip')">Skip</button>
        </div>`;
      if (_wup.stepIdx > 0) nav.innerHTML = backBtn;
      break;
    }

    case 'task': {
      const task = step.task;
      const ans  = _wup.taskAnswers[task.id];
      const taskCard = `<div class="wup-task-card">
        <div class="wup-task-title">${esc(task.title)}</div>
        ${task.priority ? `<div class="wup-task-meta">Priority ${task.priority}${task.duration ? ` · ${task.duration} min` : ''}</div>` : ''}
      </div>`;

      if (!ans) {
        body.innerHTML = `
          <div class="wup-step-eyebrow">INCOMPLETE TASK</div>
          ${taskCard}
          <div class="wup-step-question">Did you complete this task?</div>
          <div class="wup-step-choices">
            <button class="wup-choice-btn wup-choice-yes" onclick="_wupAnswerTask(true)">Yes</button>
            <button class="wup-choice-btn wup-choice-no"  onclick="_wupAnswerTask(false)">No</button>
          </div>`;
        if (_wup.stepIdx > 0) nav.innerHTML = backBtn;
      } else if (ans.done === true && ans.doneAt === undefined) {
        body.innerHTML = `
          <div class="wup-step-eyebrow">COMPLETED</div>
          ${taskCard}
          <div class="wup-step-question">When did you finish?</div>
          <div class="wup-time-row">
            <input type="time" class="wup-time-input" id="wupFinishTime" />
          </div>`;
        nav.innerHTML = `
          <button class="wup-btn-ghost wup-nav-back" onclick="_wupBackInTask()">← Back</button>
          <button class="wup-btn-primary" onclick="_wupSubmitFinishTime()">Next →</button>`;
      } else if (ans.done === false && ans.carryToToday === undefined) {
        body.innerHTML = `
          <div class="wup-step-eyebrow">NOT COMPLETED</div>
          ${taskCard}
          <div class="wup-step-question">Add this to today's queue?</div>
          <div class="wup-step-choices">
            <button class="wup-choice-btn wup-choice-yes" onclick="_wupAnswerCarry(true)">Yes</button>
            <button class="wup-choice-btn wup-choice-no"  onclick="_wupAnswerCarry(false)">No</button>
          </div>`;
        nav.innerHTML = `<button class="wup-btn-ghost wup-nav-back" onclick="_wupBackInTask()">← Back</button>`;
      } else {
        _wupAdvance();
        return;
      }
      break;
    }

    case 'add-tasks': {
      const isAllDone = step.allCompleted;
      const added     = _wup.addedTasks;
      body.innerHTML = `
        ${isAllDone
          ? `<div class="wup-step-eyebrow">ALL CAUGHT UP</div>
             <div class="wup-step-heading">All tasks were completed.</div>
             <div class="wup-step-sub">Anything else to add from this day?</div>`
          : `<div class="wup-step-eyebrow">ANYTHING ELSE?</div>
             <div class="wup-step-question">Were there other tasks from this day?</div>`}
        ${added.length ? `<div class="wup-added-list">${added.map((t, i) => `
          <div class="wup-added-item">
            <span class="wup-added-title">${esc(t.title)}</span>
            <span class="wup-added-time">${t.startTime ? fmtTimePST(_wup.date + 'T' + t.startTime) : ''}${t.endTime ? ' – ' + fmtTimePST(_wup.date + 'T' + t.endTime) : ''}</span>
            <button class="wup-added-remove" onclick="_wupRemoveAdded(${i})">✕</button>
          </div>`).join('')}</div>` : ''}
        ${_wup.addFormOpen ? _wupAddFormHtml() : ''}`;
      if (!_wup.addFormOpen) {
        nav.innerHTML = `
          ${_wup.stepIdx > 0 ? backBtn : ''}
          <button class="wup-btn-secondary" onclick="_wupOpenAddForm()">+ Add a Task</button>
          <button class="wup-btn-primary" onclick="_wupAdvance()">Done →</button>`;
      }
      break;
    }

    case 'confirm': {
      let summaryHtml = '';
      const taskSteps       = _wup.steps.filter(s => s.type === 'task');
      const completedTasks  = taskSteps.filter(s => _wup.taskAnswers[s.task.id]?.done);
      const incompleteTasks = taskSteps.filter(s => _wup.taskAnswers[s.task.id]?.done === false);
      if (completedTasks.length) {
        summaryHtml += `<div class="wup-confirm-section"><div class="wup-confirm-label">Completed</div>
          ${completedTasks.map(s => {
            const ans = _wup.taskAnswers[s.task.id];
            return `<div class="wup-confirm-item">
              <span class="wup-confirm-dot wup-dot-done"></span>
              ${esc(s.task.title)}${ans.doneAt ? ' · finished ' + fmtTimePST(_wup.date + 'T' + ans.doneAt) : ''}
            </div>`;
          }).join('')}</div>`;
      }
      if (incompleteTasks.length) {
        summaryHtml += `<div class="wup-confirm-section"><div class="wup-confirm-label">Not Completed</div>
          ${incompleteTasks.map(s => {
            const ans = _wup.taskAnswers[s.task.id];
            return `<div class="wup-confirm-item">
              <span class="wup-confirm-dot wup-dot-incomplete"></span>
              ${esc(s.task.title)}${ans.carryToToday ? ' · added to today' : ''}
            </div>`;
          }).join('')}</div>`;
      }
      if (_wup.addedTasks.length) {
        summaryHtml += `<div class="wup-confirm-section"><div class="wup-confirm-label">Added</div>
          ${_wup.addedTasks.map(t => `<div class="wup-confirm-item">
            <span class="wup-confirm-dot wup-dot-added"></span>
            ${esc(t.title)}${t.startTime ? ' · ' + fmtTimePST(_wup.date + 'T' + t.startTime) : ''}
          </div>`).join('')}</div>`;
      }
      if (!summaryHtml) summaryHtml = '<div class="wup-confirm-empty">Day marked as wrapped up.</div>';
      body.innerHTML = `
        <div class="wup-step-eyebrow">REVIEW</div>
        <div class="wup-step-heading">Here's your updated day.</div>
        <div class="wup-confirm-summary">${summaryHtml}</div>`;
      nav.innerHTML = `${backBtn}<button class="wup-btn-primary" onclick="commitWrapUp()">Save &amp; Close</button>`;
      break;
    }
  }
}

function _wupAddFormHtml() {
  const rules = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;
  const opts  = rules.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  return `<div class="wup-add-form" id="wupAddForm">
    <input type="text" class="wup-add-input" id="wupAddTitle" placeholder="Task title" maxlength="80" />
    <div class="wup-add-row">
      <label class="wup-add-label">Category</label>
      <select class="wup-add-select" id="wupAddCategory">${opts}</select>
    </div>
    <div class="wup-add-row">
      <label class="wup-add-label">Start</label>
      <input type="time" class="wup-time-input" id="wupAddStart" />
      <label class="wup-add-label">End</label>
      <input type="time" class="wup-time-input" id="wupAddEnd" />
    </div>
    <div class="wup-add-actions">
      <button class="wup-btn-primary" onclick="_wupSubmitAddTask()">Add Task</button>
      <button class="wup-btn-ghost" onclick="_wupCancelAddForm()">Cancel</button>
    </div>
  </div>`;
}

export function _wupGoBack() {
  if (_wup.stepIdx <= 0) return;
  _wup.stepIdx--;
  _wup.addFormOpen = false;
  const step = _wup.steps[_wup.stepIdx];
  if (step.type === 'task') delete _wup.taskAnswers[step.task.id];
  renderWrapUpTimeline();
  renderWupStep();
}

export function _wupBackInTask() {
  const step = _wup.steps[_wup.stepIdx];
  if (step.type === 'task') delete _wup.taskAnswers[step.task.id];
  renderWupStep();
}

export function _wupAdvance() {
  if (!_wup || _wup.stepIdx >= _wup.steps.length - 1) return;
  _wup.stepIdx++;
  _wup.addFormOpen = false;
  renderWupStep();
}

export function _wupResolveOlderDay(resolution) {
  const step = _wup.steps[_wup.stepIdx];
  if (step.type !== 'older-day') return;
  if (resolution !== 'skip') markDayResolved(step.date, resolution);
  _wupAdvance();
}

export function _wupAnswerTask(done) {
  const step = _wup.steps[_wup.stepIdx];
  if (step.type !== 'task') return;
  _wup.taskAnswers[step.task.id] = { done };
  renderWupStep();
}

export function _wupSubmitFinishTime() {
  const step = _wup.steps[_wup.stepIdx];
  if (step.type !== 'task') return;
  const input = document.getElementById('wupFinishTime');
  if (!input || !input.value) { if (input) input.classList.add('wup-input-error'); return; }
  _wup.taskAnswers[step.task.id].doneAt = input.value;
  renderWrapUpTimeline();
  _wupAdvance();
}

export function _wupAnswerCarry(carry) {
  const step = _wup.steps[_wup.stepIdx];
  if (step.type !== 'task') return;
  _wup.taskAnswers[step.task.id].carryToToday = carry;
  _wupAdvance();
}

export function _wupOpenAddForm() {
  _wup.addFormOpen = true;
  renderWupStep();
  setTimeout(() => document.getElementById('wupAddTitle')?.focus(), 40);
}

export function _wupCancelAddForm() {
  _wup.addFormOpen = false;
  renderWupStep();
}

export function _wupSubmitAddTask() {
  const title    = (document.getElementById('wupAddTitle')?.value || '').trim();
  const category = document.getElementById('wupAddCategory')?.value || '';
  const startVal = document.getElementById('wupAddStart')?.value  || '';
  const endVal   = document.getElementById('wupAddEnd')?.value    || '';
  let valid = true;
  if (!title)    { document.getElementById('wupAddTitle')?.classList.add('wup-input-error');  valid = false; }
  if (!startVal) { document.getElementById('wupAddStart')?.classList.add('wup-input-error'); valid = false; }
  if (!endVal)   { document.getElementById('wupAddEnd')?.classList.add('wup-input-error');   valid = false; }
  if (!valid) return;
  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);
  if (eh * 60 + em <= sh * 60 + sm) {
    document.getElementById('wupAddEnd')?.classList.add('wup-input-error');
    return;
  }
  _wup.addedTasks.push({
    id: Date.now(), title, category, startTime: startVal, endTime: endVal,
    duration: (eh * 60 + em) - (sh * 60 + sm),
  });
  _wup.addFormOpen = false;
  renderWrapUpTimeline();
  renderWupStep();
}

export function _wupRemoveAdded(idx) {
  _wup.addedTasks.splice(idx, 1);
  renderWrapUpTimeline();
  renderWupStep();
}

export function _wupMaybeLater() {
  document.getElementById('wupOverlay').classList.remove('active');
  _wup = null;
}

const WUP_PX_PER_MIN = 44 / 60;

function renderWrapUpTimeline() {
  if (!_wup) return;
  const container = document.getElementById('wupCalContainer');
  if (!container) return;
  const date    = _wup.date;
  const histDoc = _wup.historyDoc;
  const calStart = state.calStart;
  const calEnd   = state.calEnd;
  const wupY     = mins => (mins - calStart) * WUP_PX_PER_MIN + 8;
  const blocks   = [];

  // If no history doc exists (gap day), fall back to state.doneTasks filtered to this date
  const tz = state.timezone || 'America/Los_Angeles';
  const sourceTasks = histDoc?.doneTasks ?? state.doneTasks.filter(t => {
    if (!t.doneAt) return false;
    const p = new Date(new Date(t.doneAt).toLocaleString('en-US', { timeZone: tz }));
    return `${p.getFullYear()}-${pad2(p.getMonth() + 1)}-${pad2(p.getDate())}` === date;
  });

  for (const task of sourceTasks) {
    if (task.isBreak) continue;
    let startMins, endMins;
    if (task.startTime && task.endTime) {
      startMins = parseDateLocalMins(task.startTime);
      endMins   = parseDateLocalMins(task.endTime);
    } else {
      const p = new Date(new Date(task.doneAt || 0).toLocaleString('en-US', { timeZone: state.timezone || 'America/Los_Angeles' }));
      endMins   = p.getHours() * 60 + p.getMinutes();
      startMins = endMins - (task.duration || 60);
    }
    if (endMins > startMins) blocks.push({ task, startMins, endMins, added: false });
  }

  for (const [taskId, ans] of Object.entries(_wup.taskAnswers)) {
    if (!ans.done || !ans.doneAt) continue;
    const step = _wup.steps.find(s => s.type === 'task' && String(s.task.id) === String(taskId));
    if (!step) continue;
    const [hh, mm] = ans.doneAt.split(':').map(Number);
    const endMins   = hh * 60 + mm;
    const startMins = endMins - (step.task.duration || 60);
    blocks.push({ task: step.task, startMins, endMins, added: false });
  }

  for (const t of _wup.addedTasks) {
    const [sh, sm] = t.startTime.split(':').map(Number);
    const [eh, em] = t.endTime.split(':').map(Number);
    blocks.push({ task: { ...t, type: 'scheduled' }, startMins: sh * 60 + sm, endMins: eh * 60 + em, added: true });
  }

  blocks.sort((a, b) => a.startMins - b.startMins);
  container.style.height = ((calEnd - calStart) * WUP_PX_PER_MIN + 24) + 'px';
  container.innerHTML = '';

  for (let h = Math.floor(calStart / 60); h <= Math.ceil(calEnd / 60); h++) {
    const row = document.createElement('div');
    row.className = 'cal-hour-row';
    row.style.top = wupY(h * 60) + 'px';
    const label = h === 12 ? '12PM' : h > 12 ? `${h - 12}PM` : `${h}AM`;
    row.innerHTML = `<span class="cal-hour-label">${label}</span><div class="cal-hour-line"></div>`;
    container.appendChild(row);
  }

  const track = document.createElement('div');
  track.className = 'cal-track';
  for (const b of blocks) {
    const yStart = wupY(Math.max(b.startMins, calStart));
    const yEnd   = wupY(Math.min(b.endMins,   calEnd));
    const height = Math.max(yEnd - yStart, 12);
    if (yStart > (calEnd - calStart) * WUP_PX_PER_MIN + 8 || yEnd < 8) continue;
    const dur   = b.endMins - b.startMins;
    const label = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60 ? ` ${dur % 60}m` : ''}` : `${dur}m`;
    const block = document.createElement('div');
    block.className = b.added
      ? 'cal-block wup-block-added sched-block done-block'
      : `cal-block done-block${b.task.isBreak ? ' break-block' : b.task.type === 'scheduled' ? ' sched-block' : b.task.priority ? ` pc-${b.task.priority}` : ''}`;
    block.style.top    = yStart + 'px';
    block.style.height = height + 'px';
    block.innerHTML    = `<span class="cal-block-title">${esc(b.task.title)}</span><span class="cal-block-meta">${label}</span>`;
    track.appendChild(block);
  }
  container.appendChild(track);

  const first = blocks.find(b => b.startMins >= calStart);
  const scrollTo = first ? wupY(first.startMins) - 44 : wupY(9 * 60) - 44;
  const section = document.getElementById('wupCalSection');
  if (section) section.scrollTop = Math.max(0, scrollTo);
}

export async function commitWrapUp() {
  if (!_wup || !state.db || !state.currentUser) return;
  const date    = _wup.date;
  const histDoc = _wup.historyDoc || {};
  const pstOffsetMs = Date.now() - getPST().getTime();

  const newDoneTasks = [...(histDoc.doneTasks || [])];

  for (const [taskId, ans] of Object.entries(_wup.taskAnswers)) {
    if (!ans.done) continue;
    const step = _wup.steps.find(s => s.type === 'task' && String(s.task.id) === String(taskId));
    if (!step) continue;
    const task     = step.task;
    const doneTask = { ...task };
    if (ans.doneAt) {
      const [hh, mm] = ans.doneAt.split(':').map(Number);
      const endMins   = hh * 60 + mm;
      const startMins = endMins - (task.duration || 60);
      doneTask.startTime = `${date}T${fmtMins(startMins)}`;
      doneTask.endTime   = `${date}T${ans.doneAt}`;
      doneTask.doneAt    = new Date(date + 'T' + ans.doneAt + ':00').getTime() + pstOffsetMs;
    } else {
      doneTask.doneAt = Date.now();
    }
    newDoneTasks.push(doneTask);
  }

  for (const t of _wup.addedTasks) {
    newDoneTasks.push({
      id: t.id, title: t.title, type: 'scheduled', duration: t.duration,
      startTime: `${date}T${t.startTime}`, endTime: `${date}T${t.endTime}`,
      doneAt: new Date(date + 'T' + t.endTime + ':00').getTime() + pstOffsetMs,
      categoryOverride: t.category || null,
    });
  }

  const updatedIncomplete = (histDoc.incompleteTasks || []).filter(t => {
    const ans = _wup.taskAnswers[t.id];
    return !ans || ans.done === false;
  });

  const catOverrides = { ...(histDoc.taskCategoryOverrides || {}) };
  for (const t of _wup.addedTasks) { if (t.category) catOverrides[t.title] = t.category; }

  const report = _recomputeWrapUpReport(newDoneTasks, catOverrides);

  try {
    await state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(date)
      .set({
        date,
        doneTasks:             newDoneTasks,
        incompleteTasks:       updatedIncomplete,
        taskCategoryOverrides: catOverrides,
        dayEnded:              true,
        wrapUpCompleted:       true,
        wrapUpSavedAt:         Date.now(),
        stressScore:           report.stressScore,
        priorityBreakdown:     report.priorityBreakdown,
        timePerTask:           report.timePerTask,
        savedAt:               Date.now(),
        ...(histDoc.choice ? { choice: histDoc.choice } : {}),
      }, { merge: true });
  } catch(e) {
    console.error('[Queue] commitWrapUp failed:', e);
  }

  const toCarry = _wup.steps
    .filter(s => s.type === 'task' && _wup.taskAnswers[s.task.id]?.carryToToday)
    .map(s => ({ ...s.task, id: Date.now() + Math.random(), carriedFrom: date }));
  if (toCarry.length) { state.tasks.push(...toCarry); save(); }

  document.getElementById('wupOverlay').classList.remove('active');
  _wup = null;
  refreshStreak();
}

function _recomputeWrapUpReport(doneTasks, catOverrides) {
  const rules      = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;
  const otherCatId = rules[rules.length - 1].id;
  const nonBreak   = doneTasks.filter(t => !t.isBreak);
  const timeMap = {};
  let urgencyRaw = 0, sTotal = 0, workMins = 0;
  const pCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of nonBreak) {
    const catId = catOverrides[t.title] || getCategoryForTask(t.title, {}, t.id, t.categoryOverride);
    const w = catId === otherCatId ? 0.3 : 1.0;
    let mins = 0;
    if (t.startTime && t.endTime) mins = parseDateLocalMins(t.endTime) - parseDateLocalMins(t.startTime);
    else mins = t.duration || 0;
    if (mins > 0) { timeMap[t.title || 'Untitled'] = (timeMap[t.title || 'Untitled'] || 0) + mins; }
    sTotal += w; workMins += mins * w;
    if (t.priority === 1 || t.priority === 2) urgencyRaw += w;
    if (t.priority && pCount[t.priority] !== undefined) pCount[t.priority]++;
  }
  const timePerTask = Object.entries(timeMap).map(([title, mins]) => ({ title, mins })).sort((a, b) => b.mins - a.mins);
  const priorityBreakdown = { urgent: pCount[1], high: pCount[2], medium: pCount[3], low: pCount[4], total: nonBreak.length };
  const hoursNorm   = (Math.min(Math.max(workMins / 60, 4), 12) - 4) / 8;
  const volumeNorm  = (Math.min(Math.max(sTotal, 3), 20) - 3) / 17;
  const urgencyNorm = Math.min(urgencyRaw, 10) / 10;
  const stressScore = Math.min(Math.max(Math.round((3 * hoursNorm + volumeNorm + 0.5 * urgencyNorm) / 4.5 * 10), 1), 10);
  return { timePerTask, priorityBreakdown, stressScore };
}
