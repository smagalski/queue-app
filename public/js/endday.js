import { state } from './state.js';
import { DEFAULT_DUR, DEFAULT_CATEGORY_RULES, DAYS, P_COLS, P_TEXT, P_NAMES } from './constants.js';
import { getPST, todayPstDateStr, parseDateLocalMins, fmtMins, pad2, fmtTaskMins, esc } from './utils.js';
import { save, injectRecurringTasks } from './persistence.js';
import { render, isScheduled } from './render.js';
import { getCategoryForTask, getStressWeights, getStressExcludedCats, _recomputeStressScore } from './categories.js';
import { refreshStreak } from './streak.js';

// Per-user localStorage key helper
function _lsKey(base) {
  const uid = state.currentUser?.uid;
  return uid ? `q_${base}_${uid}` : null;
}

// Module-local state
let _edmDragTaskId = null;
let _edmOverrides  = {};
let _edmReport     = null;
let _hdcDragTitle  = null;
let _hdcDragDate   = null;

// ── Local display helpers ──────────────────────────────────────────────────

function buildPriorityHtml(pb, total, chipClass) {
  let html = '';
  for (let p = 1; p <= 4; p++) {
    const cnt = pb[['','urgent','high','medium','low'][p]] || 0;
    if (!cnt) continue;
    const pct = total > 0 ? Math.round(cnt / total * 100) : 0;
    html += `<span class="${chipClass}" style="background:${P_COLS[p]};color:${P_TEXT[p]}">${P_NAMES[p]} ${pct}%</span>`;
  }
  return html;
}

function stressColor(score) {
  if (score <= 3) return '#4caf7d';
  if (score <= 6) return '#f0a500';
  return '#ff6b8a';
}

function stressLabel(score) {
  if (score <= 2) return 'Very relaxed day';
  if (score <= 4) return 'Light load';
  if (score <= 6) return 'Moderate';
  if (score <= 8) return 'Demanding day';
  return 'High stress day';
}

// ── computeDayReport ───────────────────────────────────────────────────────

export function computeDayReport() {
  const today     = todayPstDateStr();
  const todayDone = state.doneTasks.filter(t => {
    const ts = t.doneAt || 0;
    const p  = new Date(new Date(ts).toLocaleString('en-US', { timeZone: state.timezone || 'America/Los_Angeles' }));
    return `${p.getFullYear()}-${pad2(p.getMonth()+1)}-${pad2(p.getDate())}` === today;
  });

  const timeMap = {};
  for (const t of todayDone) {
    if (t.isBreak) continue;
    let mins = 0;
    if (t.startTime && t.endTime) {
      mins = parseDateLocalMins(t.endTime) - parseDateLocalMins(t.startTime);
    } else { mins = t.duration || 0; }
    if (mins <= 0) continue;
    const key = t.title || 'Untitled';
    timeMap[key] = (timeMap[key] || 0) + mins;
  }
  const timePerTask = Object.entries(timeMap)
    .map(([title, mins]) => ({ title, mins }))
    .sort((a, b) => b.mins - a.mins);

  const nonBreak = todayDone.filter(t => !t.isBreak);
  const pCount   = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of nonBreak) { if (t.priority && pCount[t.priority] !== undefined) pCount[t.priority]++; }
  const total = nonBreak.length;
  const priorityBreakdown = { urgent: pCount[1], high: pCount[2], medium: pCount[3], low: pCount[4], total };

  const otherCatId   = state.categoryRules.length ? state.categoryRules[state.categoryRules.length - 1].id : 'other';
  const OTHER_WEIGHT = 0.3;
  const _stressW = t => getCategoryForTask(t.title, {}, t.id, t.categoryOverride) === otherCatId ? OTHER_WEIGHT : 1.0;
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
  const urgencyNorm = Math.min(urgencyRaw, 10) / 10;
  const volumeNorm  = (Math.min(Math.max(sTotal, 3), 20) - 3) / 17;
  const workMins    = Object.values(_stressTimeMap).reduce((s, m) => s + m, 0);
  const workHours   = workMins / 60;
  const hoursNorm   = (Math.min(Math.max(workHours, 4), 12) - 4) / 8;
  const rawScore    = (3 * hoursNorm + volumeNorm + 0.5 * urgencyNorm) / 4.5 * 10;
  const stressScore = Math.min(Math.max(Math.round(rawScore), 1), 10);

  const incompleteTasks = [...state.tasks];
  return { todayDone, timePerTask, priorityBreakdown, stressScore, incompleteTasks };
}

// ── End Day modal ──────────────────────────────────────────────────────────

export function openEndDayModal() {
  const report = computeDayReport();
  _edmReport   = report;
  _edmOverrides = {};

  if (state.db && state.currentUser) {
    state.db.collection('users').doc(state.currentUser.uid).collection('history')
      .doc(todayPstDateStr()).get()
      .then(doc => {
        if (doc.exists && doc.data().taskCategoryOverrides) {
          Object.assign(_edmOverrides, doc.data().taskCategoryOverrides);
          _renderEdmCategories();
        }
      }).catch(() => {});
  }

  const { priorityBreakdown, stressScore, incompleteTasks } = report;
  const col   = stressColor(stressScore);
  const total = priorityBreakdown.total;
  const priorityHtml = buildPriorityHtml(priorityBreakdown, total, 'edm-priority-chip')
    || '<span style="color:var(--text-dim);font-size:11px">No priority data</span>';

  document.getElementById('edmBody').innerHTML = `
    <div>
      <div class="edm-section-label">Time Spent</div>
      <div id="edmCatSections"></div>
    </div>
    <div>
      <div class="edm-section-label">Priority Breakdown</div>
      <div class="edm-priority-row">${priorityHtml}</div>
    </div>
    <div class="edm-stress">
      <div class="edm-stress-score" style="color:${col}">${stressScore}</div>
      <div>
        <div class="edm-stress-desc" style="color:${col}">${stressLabel(stressScore)}</div>
        <div class="edm-stress-label">Stress score out of 10 — based on task urgency, volume, and hours worked.</div>
      </div>
    </div>`;

  _renderEdmCategories();

  const inc = incompleteTasks.length;
  document.getElementById('edmIncompleteCount').textContent =
    inc > 0 ? `${inc} task${inc > 1 ? 's' : ''} remaining in queue` : 'No remaining tasks';

  document.getElementById('endDayOverlay').classList.add('active');
}

export function closeEndDayModal() {
  document.getElementById('endDayOverlay').classList.remove('active');
}

function _renderEdmCategories() {
  const el = document.getElementById('edmCatSections');
  if (!el || !_edmReport) return;

  const { todayDone } = _edmReport;
  const rules = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;

  const grouped = {};
  for (const cat of rules) grouped[cat.id] = [];

  for (const task of todayDone) {
    if (task.isBreak) continue;
    let mins = 0;
    if (task.startTime && task.endTime) {
      mins = parseDateLocalMins(task.endTime) - parseDateLocalMins(task.startTime);
    } else { mins = task.duration || 0; }
    const catId = getCategoryForTask(task.title, _edmOverrides, task.id, task.categoryOverride);
    if (!grouped[catId]) grouped[catId] = [];
    grouped[catId].push({ task, mins });
  }

  const hasTasks = todayDone.filter(t => !t.isBreak).length > 0;
  if (!hasTasks) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">No completed tasks recorded.</div>';
    return;
  }

  let html = '';
  for (const cat of rules) {
    const items = grouped[cat.id] || [];
    if (items.length === 0 && cat.keywords && cat.keywords.length > 0) continue;
    if (items.length === 0 && !cat.keywords.length) continue;

    html += `<div class="edm-cat-section" data-cat="${esc(cat.id)}"
      ondragover="edmDragOver(event,'${esc(cat.id)}')"
      ondragleave="edmDragLeave(event)"
      ondrop="edmDrop(event,'${esc(cat.id)}')">
      <div class="edm-cat-header">${esc(cat.name.toUpperCase())}</div>
      <div class="edm-cat-tasks">`;

    for (const { task, mins } of items) {
      html += `<div class="edm-drag-row" draggable="true" data-tid="${task.id}"
        ondragstart="edmDragStart(event,${task.id})"
        ondragend="edmDragEnd(event)">
        <span class="edm-drag-handle">⠿</span>
        <span class="edm-task-title">${esc(task.title)}</span>
        ${mins > 0 ? `<span class="edm-task-time">${fmtTaskMins(mins)}</span>` : ''}
      </div>`;
    }

    const catTotal = items.reduce((s, { mins }) => s + mins, 0);
    if (catTotal > 0) html += `<div class="edm-cat-subtotal"><span>Total</span><span>${fmtTaskMins(catTotal)}</span></div>`;
    html += `</div></div>`;
  }

  el.innerHTML = html || '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">No completed tasks recorded.</div>';
}

// EDM drag handlers
export function edmDragStart(event, taskId) {
  _edmDragTaskId = taskId;
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('edm-dragging');
}

export function edmDragEnd(event) {
  _edmDragTaskId = null;
  event.currentTarget.classList.remove('edm-dragging');
  document.querySelectorAll('.edm-cat-section').forEach(s => s.classList.remove('edm-drag-over'));
}

export function edmDragOver(event, catId) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.edm-cat-section').forEach(s => s.classList.remove('edm-drag-over'));
  const section = event.currentTarget.closest('.edm-cat-section') || event.currentTarget;
  section.classList.add('edm-drag-over');
}

export function edmDragLeave(event) {
  const section = event.currentTarget.closest('.edm-cat-section') || event.currentTarget;
  if (!section.contains(event.relatedTarget)) section.classList.remove('edm-drag-over');
}

export function edmDrop(event, catId) {
  event.preventDefault();
  const section = event.currentTarget.closest('.edm-cat-section') || event.currentTarget;
  section.classList.remove('edm-drag-over');
  if (_edmDragTaskId != null && catId) {
    _edmOverrides[_edmDragTaskId] = catId;
    _renderEdmCategories();
    if (state.db && state.currentUser) {
      state.db.collection('users').doc(state.currentUser.uid).collection('history')
        .doc(todayPstDateStr())
        .set({ taskCategoryOverrides: _edmOverrides }, { merge: true })
        .catch(() => {});
    }
  }
  _edmDragTaskId = null;
}

// ── Commit / History ───────────────────────────────────────────────────────

export function commitEndDay(choice) {
  const today  = todayPstDateStr();
  const report = computeDayReport();

  if (choice === 'clear') {
    state.tasks = [];
  } else {
    const _nowMinsEod = getPST().getHours() * 60 + getPST().getMinutes();
    state.tasks = state.tasks.map(t => {
      if (isScheduled(t)) {
        const etMins = t.endTime   ? parseDateLocalMins(t.endTime)
                     : t.startTime ? parseDateLocalMins(t.startTime) + (t.duration || DEFAULT_DUR)
                     : null;
        if (etMins != null && etMins < _nowMinsEod) {
          const { startTime, endTime, calStartTime, ...flex } = t;
          return { ...flex, type: 'flex', priority: t.priority || 3, carriedFrom: today };
        }
      }
      return { ...t, carriedFrom: today };
    });
  }

  document.getElementById('endDayOverlay').classList.remove('active');
  const choiceKey = _lsKey('dayEndedChoice');
  if (choiceKey) localStorage.setItem(choiceKey, choice);
  setDayEndedState(true);
  refreshStreak();
  save(); render();
}

function saveDayHistory(date, dayDone, incomplete, choice, stressScore, priorityBreakdown, timePerTask, taskCategoryOverrides) {
  if (!state.db || !state.currentUser) return;
  const payload = {
    date, stressScore, priorityBreakdown, timePerTask,
    doneTasks:        dayDone,
    incompleteTasks:  incomplete.map(t => ({ id: t.id, title: t.title, priority: t.priority, duration: t.duration })),
    choice,
    dayEnded:         true,
    savedAt:          Date.now(),
  };
  if (taskCategoryOverrides && Object.keys(taskCategoryOverrides).length) {
    payload.taskCategoryOverrides = taskCategoryOverrides;
  }
  state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(date)
    .set(payload)
    .catch(err => console.error('[Queue] History save failed:', err));
}

export function updateTodayHistory() {
  const today = todayPstDateStr();
  const endedKey = _lsKey('dayEnded');
  const ended = endedKey ? localStorage.getItem(endedKey) : null;
  if (ended !== today || !state.db || !state.currentUser) return;
  const choiceKey = _lsKey('dayEndedChoice');
  const choice = (choiceKey ? localStorage.getItem(choiceKey) : null) || null;
  const report = computeDayReport();
  saveDayHistory(today, report.todayDone, report.incompleteTasks, choice, report.stressScore, report.priorityBreakdown, report.timePerTask, _edmOverrides);
}

// ── Day ended state ────────────────────────────────────────────────────────

export function setDayEndedState(ended) {
  document.getElementById('dayEndedOverlay').classList.toggle('active', ended);
  const endedKey  = _lsKey('dayEnded');
  const choiceKey = _lsKey('dayEndedChoice');
  if (ended) {
    document.body.classList.add('day-ended');
    if (endedKey) localStorage.setItem(endedKey, todayPstDateStr());
  } else {
    document.body.classList.remove('day-ended');
    if (endedKey)  localStorage.removeItem(endedKey);
    if (choiceKey) localStorage.removeItem(choiceKey);
  }
}

export function resumeDay() {
  setDayEndedState(false);
  refreshStreak();
  if (state.db && state.currentUser) {
    const today = todayPstDateStr();
    state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(today)
      .update({ dayEnded: firebase.firestore.FieldValue.delete() })
      .catch(() => {});
  }
  render();
}

export function checkDayEndedFirestore() {
  if (!state.db || !state.currentUser) return;
  const today = todayPstDateStr();
  state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(today)
    .get()
    .then(doc => {
      if (doc.exists && doc.data().dayEnded) {
        const endedKey  = _lsKey('dayEnded');
        const choiceKey = _lsKey('dayEndedChoice');
        if (endedKey)  localStorage.setItem(endedKey, today);
        if (choiceKey) localStorage.setItem(choiceKey, doc.data().choice || 'carry');
        setDayEndedState(true);
      }
    })
    .catch(err => console.error('[Queue] Day ended check failed:', err));
}

export function checkDayEndedReset() {
  const uid = state.currentUser?.uid;
  if (!uid) return;
  const ended = localStorage.getItem(`q_dayEnded_${uid}`);
  if (ended && ended < todayPstDateStr()) {
    setDayEndedState(false);
    injectRecurringTasks();
  } else if (ended) {
    document.body.classList.add('day-ended');
  }
}

// ── Day Off ────────────────────────────────────────────────────────────────

export function showDayOffOverlay() {
  document.getElementById('dayOffDayName').textContent = DAYS[getPST().getDay()];
  document.getElementById('dayOffOverlay').classList.add('active');
}

export function enterDayOff() {
  const today = todayPstDateStr();
  const dayOffKey = _lsKey('dayOff');
  if (dayOffKey) localStorage.setItem(dayOffKey, today);
  showDayOffOverlay();
  if (state.db && state.currentUser) {
    state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(today).set({
      date: today, dayOff: true, savedAt: Date.now(),
    }).then(() => refreshStreak()).catch(err => console.error('[Queue] Day off save failed:', err));
  }
}

export function cancelDayOff() {
  const dayOffKey = _lsKey('dayOff');
  const today = (dayOffKey ? localStorage.getItem(dayOffKey) : null) || todayPstDateStr();
  if (dayOffKey) localStorage.removeItem(dayOffKey);
  document.getElementById('dayOffOverlay').classList.remove('active');
  if (state.db && state.currentUser) {
    state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(today)
      .delete()
      .catch(err => console.error('[Queue] Day off cancel failed:', err));
  }
}

export function checkDayOffState() {
  const uid = state.currentUser?.uid;
  if (!uid) return;
  const stored = localStorage.getItem(`q_dayOff_${uid}`);
  const today  = todayPstDateStr();
  if (stored === today) showDayOffOverlay();
  else if (stored && stored < today) localStorage.removeItem(`q_dayOff_${uid}`);
}

export function checkDayOffFirestore() {
  if (!state.db || !state.currentUser) return;
  const today = todayPstDateStr();
  state.db.collection('users').doc(state.currentUser.uid).collection('history').doc(today)
    .get()
    .then(doc => {
      if (doc.exists && doc.data().dayOff) {
        const dayOffKey = _lsKey('dayOff');
        if (dayOffKey) localStorage.setItem(dayOffKey, today);
        showDayOffOverlay();
      }
    })
    .catch(() => {});
}

// ── History overlay ────────────────────────────────────────────────────────

export function openHistoryOverlay() {
  if (typeof closeGearMenu === 'function') closeGearMenu();
  if (!state.db || !state.currentUser) return;
  const body = document.getElementById('historyBody');
  body.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0">Loading…</div>';
  document.getElementById('historyOverlay').classList.add('active');

  state.db.collection('users').doc(state.currentUser.uid).collection('history')
    .orderBy('date', 'desc')
    .get()
    .then(snap => {
      // Build a map of date string → doc data
      const docMap = {};
      snap.docs.forEach(d => { docMap[d.data().date] = d.data(); });

      // Generate dates: yesterday back 30 days, extend to cover earliest record
      const pst = getPST();
      const todayY = pst.getFullYear(), todayM = pst.getMonth(), todayD = pst.getDate();
      const dates = [];
      const LOOKBACK = 30;
      const earliestDoc = snap.docs.length ? snap.docs[snap.docs.length - 1].data().date : null;

      for (let i = 1; i <= LOOKBACK; i++) {
        const d = new Date(todayY, todayM, todayD - i);
        const dateStr = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
        dates.push(dateStr);
        if (i >= LOOKBACK && earliestDoc && dateStr > earliestDoc) {
          // Keep going until we pass the earliest recorded day
          // (Loop limit handles this via LOOKBACK; extend if needed)
        }
      }
      // If earliest doc is older than 30 days, extend the range
      if (earliestDoc && earliestDoc < dates[dates.length - 1]) {
        const [ey, em, ed] = earliestDoc.split('-').map(Number);
        const baseDate = new Date(todayY, todayM, todayD);
        const earlyDate = new Date(ey, em - 1, ed);
        const diffDays = Math.round((baseDate - earlyDate) / 86400000);
        for (let i = LOOKBACK + 1; i <= diffDays; i++) {
          const d = new Date(todayY, todayM, todayD - i);
          const dateStr = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
          dates.push(dateStr);
        }
      }

      if (dates.length === 0 && snap.empty) {
        body.innerHTML = '<div class="history-empty">No day history yet.<br>Press "End Day" to start recording.</div>';
        return;
      }

      body.innerHTML = dates.map(dateStr => {
        if (docMap[dateStr]) {
          return renderHistoryDay(docMap[dateStr]);
        } else {
          return renderHistoryGapDay(dateStr);
        }
      }).join('');
    })
    .catch(err => {
      console.error('[Queue] History load failed:', err);
      body.innerHTML = '<div class="history-empty">Failed to load history.</div>';
    });
}

function renderHistoryGapDay(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dateObj   = new Date(y, m-1, d);
  const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const tz = state.timezone || 'America/Los_Angeles';
  const pad2 = n => String(n).padStart(2, '0');
  const hasData = state.doneTasks.some(t => {
    if (!t.doneAt) return false;
    const p = new Date(new Date(t.doneAt).toLocaleString('en-US', { timeZone: tz }));
    return `${p.getFullYear()}-${pad2(p.getMonth() + 1)}-${pad2(p.getDate())}` === dateStr;
  });
  const badge     = hasData ? 'Unfinished' : 'Not Tracked';
  const wrapLabel = hasData ? 'Wrap Up Tracking →' : 'Wrap Up →';
  return `<div class="history-day-card hdc-gap-card" id="hdcGap_${dateStr.replace(/-/g,'')}">
    <div class="hdc-header">
      <div class="hdc-date-row">
        <div class="hdc-date">${dateLabel}</div>
        <span class="hdc-unresolved-badge">${badge}</span>
      </div>
      <div class="hdc-gap-actions">
        <button class="hdc-wrap-btn" onclick="openWrapUpWizardForDate('${dateStr}')">${wrapLabel}</button>
        <button class="hdc-gap-btn" onclick="markHistoryDay('${dateStr}','dayOff')">Day Off</button>
        <button class="hdc-gap-btn" onclick="markHistoryDay('${dateStr}','notTracked')">Workday (Not Tracked)</button>
      </div>
    </div>
  </div>`;
}

export function markHistoryDay(dateStr, type) {
  if (!state.db || !state.currentUser) return;
  const data = { date: dateStr, savedAt: Date.now() };
  if (type === 'dayOff')     data.dayOff       = true;
  if (type === 'notTracked') data.dayNotTracked = true;
  state.db.collection('users').doc(state.currentUser.uid).collection('history')
    .doc(dateStr)
    .set(data)
    .then(() => {
      // Replace the gap card with the appropriate badge card
      const gapEl = document.getElementById(`hdcGap_${dateStr.replace(/-/g,'')}`);
      if (gapEl) gapEl.outerHTML = renderHistoryDay(data);
    })
    .catch(err => console.error('[Queue] markHistoryDay failed:', err));
}

export function closeHistoryOverlay() {
  document.getElementById('historyOverlay').classList.remove('active');
}

// ── Day history drag-to-recategorize ──────────────────────────────────────

export function hdcDragStart(event, date, title) {
  _hdcDragTitle = title;
  _hdcDragDate  = date;
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('edm-dragging');
}

export function hdcDragEnd(event) {
  _hdcDragTitle = null;
  _hdcDragDate  = null;
  event.currentTarget.classList.remove('edm-dragging');
  document.querySelectorAll('.hdc-cat-section').forEach(s => s.classList.remove('edm-drag-over'));
}

export function hdcDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.hdc-cat-section').forEach(s => s.classList.remove('edm-drag-over'));
  event.currentTarget.classList.add('edm-drag-over');
}

export function hdcDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('edm-drag-over');
  }
}

export function hdcDrop(event, date, catId) {
  event.preventDefault();
  event.currentTarget.classList.remove('edm-drag-over');
  if (!_hdcDragTitle || !date || !catId) return;

  if (state.db && state.currentUser) {
    state.db.collection('users').doc(state.currentUser.uid).collection('history')
      .doc(date)
      .set({ taskCategoryOverrides: { [_hdcDragTitle]: catId } }, { merge: true })
      .catch(() => {});
  }

  const card = event.currentTarget.closest('.history-day-card');
  if (card) {
    card._dayData = card._dayData || {};
    card._dayData.taskCategoryOverrides = card._dayData.taskCategoryOverrides || {};
    card._dayData.taskCategoryOverrides[_hdcDragTitle] = catId;
    const tasksEl = card.querySelector('.hdc-tasks');
    if (tasksEl) {
      tasksEl.innerHTML = _buildHdcTaskHtml(card._dayData);
      const newScore = _recomputeStressScore(card._dayData);
      if (newScore != null) {
        const stressEl = card.querySelector('.hdc-stress');
        if (stressEl) {
          const col = stressColor(newScore);
          stressEl.style.background = `${col}22`;
          stressEl.style.color = col;
          stressEl.textContent = `Stress ${newScore}/10 · ${stressLabel(newScore)}`;
        }
      }
    }
  }
  _hdcDragTitle = null;
  _hdcDragDate  = null;
}

function _buildHdcTaskHtml(day) {
  const titleOverrides = {};
  if (day.taskCategoryOverrides) Object.assign(titleOverrides, day.taskCategoryOverrides);
  const rules = state.categoryRules.length ? state.categoryRules : DEFAULT_CATEGORY_RULES;
  const grouped = {};
  for (const cat of rules) grouped[cat.id] = [];
  for (const r of (day.timePerTask || [])) {
    const catId = getCategoryForTask(r.title, titleOverrides, r.title);
    if (!grouped[catId]) grouped[catId] = [];
    grouped[catId].push(r);
  }
  let html = '';
  for (const cat of rules) {
    const items = grouped[cat.id] || [];
    const escapedCatId = cat.id.replace(/'/g, "\\'");
    const catTotal = items.reduce((s, r) => s + r.mins, 0);
    html += `<div class="edm-cat-section hdc-cat-section" data-cat="${esc(cat.id)}"
      ondragover="hdcDragOver(event)"
      ondragleave="hdcDragLeave(event)"
      ondrop="hdcDrop(event,'${esc(day.date)}','${escapedCatId}')">
      <div class="edm-cat-header hdc-cat-header-sm">${esc(cat.name.toUpperCase())}${catTotal > 0 ? `<span class="hdc-cat-hd-time">${fmtTaskMins(catTotal)}</span>` : ''}</div>
      <div class="edm-cat-tasks">`;
    if (items.length === 0) {
      html += `<div class="hdc-empty-cat">—</div>`;
    } else {
      for (const r of items) {
        const escapedTitle = r.title.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        html += `<div class="edm-drag-row hdc-drag-row" draggable="true"
          ondragstart="hdcDragStart(event,'${esc(day.date)}','${escapedTitle}')"
          ondragend="hdcDragEnd(event)">
          <span class="edm-drag-handle">⠿</span>
          <span class="hdc-task-title">${esc(r.title)}</span>
          ${r.mins > 0 ? `<span class="hdc-task-time">${fmtTaskMins(r.mins)}</span>` : ''}
        </div>`;
      }
    }
    html += `</div></div>`;
  }
  return html || '<div class="history-no-data">No recorded data</div>';
}

export function renderHistoryDay(day) {
  const [y,m,d] = day.date.split('-').map(Number);
  const dateObj   = new Date(y, m-1, d);
  const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (day.dayOff) {
    return `<div class="history-day-card">
      <div class="hdc-header">
        <div class="hdc-date">${dateLabel}</div>
        <div class="hdc-day-off-badge">Day Off</div>
      </div>
    </div>`;
  }

  if (day.dayNotTracked) {
    return `<div class="history-day-card">
      <div class="hdc-header">
        <div class="hdc-date">${dateLabel}</div>
        <div class="hdc-not-tracked-badge">Not Tracked</div>
      </div>
    </div>`;
  }

  if (day.taskCategoryOverrides && day.doneTasks) {
    for (const t of day.doneTasks) {
      if (day.taskCategoryOverrides[t.id] != null && day.taskCategoryOverrides[t.title] == null) {
        day.taskCategoryOverrides[t.title] = day.taskCategoryOverrides[t.id];
      }
    }
  }

  const liveStress   = _recomputeStressScore(day);
  const displayScore = liveStress ?? day.stressScore ?? 1;
  const col          = stressColor(displayScore);
  const label        = stressLabel(displayScore);
  const taskHtml     = _buildHdcTaskHtml(day);
  const pb           = day.priorityBreakdown || {};
  const priorityHtml = buildPriorityHtml(pb, pb.total || 0, 'hdc-priority-chip');

  const cardId = `hdcCard_${day.date.replace(/-/g,'')}`;
  setTimeout(() => {
    const card = document.getElementById(cardId);
    if (card) card._dayData = day;
  }, 0);

  return `<div class="history-day-card" id="${cardId}">
    <div class="hdc-header">
      <div class="hdc-date">${dateLabel}</div>
      <div class="hdc-stress" style="background:${col}22;color:${col}">Stress ${displayScore}/10 · ${label}</div>
    </div>
    <div class="hdc-tasks">${taskHtml}</div>
    ${priorityHtml ? `<div class="hdc-priority-row">${priorityHtml}</div>` : ''}
  </div>`;
}
