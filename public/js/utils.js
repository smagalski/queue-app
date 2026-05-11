import { DAYS, MONTHS } from './constants.js';
import { state } from './state.js';

// ── Smart time picker ──────────────────────────────────────────────────────

export function getSmartTime(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('smart-time')) return el ? el.value : '';
  const h = el.querySelector('.st-hour').value.trim();
  const m = el.querySelector('.st-min').value.trim();
  if (!h || !m) return '';
  let hNum = parseInt(h, 10);
  const mNum = parseInt(m, 10);
  if (isNaN(hNum) || hNum < 1 || hNum > 12 || isNaN(mNum) || mNum < 0 || mNum > 59) return '';
  const ap = el.querySelector('.st-ampm').textContent.trim();
  if (ap === 'PM' && hNum !== 12) hNum += 12;
  if (ap === 'AM' && hNum === 12) hNum = 0;
  return `${String(hNum).padStart(2,'0')}:${String(mNum).padStart(2,'0')}`;
}

export function setSmartTime(id, val24) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.classList.contains('smart-time')) { el.value = val24 || ''; return; }
  const hourEl = el.querySelector('.st-hour');
  const minEl  = el.querySelector('.st-min');
  const ampmEl = el.querySelector('.st-ampm');
  if (!val24) { hourEl.value = ''; minEl.value = ''; ampmEl.textContent = 'AM'; return; }
  const [hStr, mStr] = val24.split(':');
  let hNum = parseInt(hStr, 10);
  const mNum = parseInt(mStr, 10);
  const ap = hNum >= 12 ? 'PM' : 'AM';
  if (hNum > 12) hNum -= 12;
  if (hNum === 0) hNum = 12;
  hourEl.value = String(hNum);
  minEl.value  = String(mNum).padStart(2, '0');
  ampmEl.textContent = ap;
}

function _stAutoAmPm(hNum, ampmEl) {
  if (hNum >= 6 && hNum <= 11) ampmEl.textContent = 'AM';
  else if (hNum === 12 || (hNum >= 1 && hNum <= 5)) ampmEl.textContent = 'PM';
}

export function initSmartTime(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('smart-time')) return;
  const hourEl = el.querySelector('.st-hour');
  const minEl  = el.querySelector('.st-min');
  const ampmEl = el.querySelector('.st-ampm');
  const onchange = el.dataset.onchange;
  const _onchangeFn = onchange ? new Function(onchange) : null;

  function fireChange() { if (_onchangeFn) _onchangeFn(); }

  hourEl.addEventListener('input', () => {
    const val = hourEl.value.replace(/\D/g,'');
    hourEl.value = val.slice(0, 2);
    const num = parseInt(val, 10);
    if (!isNaN(num)) _stAutoAmPm(num, ampmEl);
    if (val.length === 2 || (val.length === 1 && num >= 3 && num <= 9)) {
      minEl.focus(); minEl.select();
    }
    fireChange();
  });
  hourEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parseInt(hourEl.value, 10) || 12;
      const next = e.key === 'ArrowUp' ? (cur % 12) + 1 : cur === 1 ? 12 : cur - 1;
      hourEl.value = String(next);
      _stAutoAmPm(next, ampmEl);
      fireChange();
    }
  });

  minEl.addEventListener('input', () => {
    const val = minEl.value.replace(/\D/g,'');
    minEl.value = val.slice(0, 2);
    if (val.length === 2) ampmEl.focus();
    fireChange();
  });
  minEl.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !minEl.value) { hourEl.focus(); hourEl.select(); }
  });
  minEl.addEventListener('blur', () => {
    const num = parseInt(minEl.value, 10);
    if (!isNaN(num) && minEl.value.length === 1) minEl.value = String(num).padStart(2,'0');
  });

  ampmEl.addEventListener('click', e => {
    e.preventDefault();
    ampmEl.textContent = ampmEl.textContent === 'AM' ? 'PM' : 'AM';
    fireChange();
  });
  ampmEl.addEventListener('keydown', e => {
    if (e.key === 'a' || e.key === 'A') { ampmEl.textContent = 'AM'; e.preventDefault(); fireChange(); }
    if (e.key === 'p' || e.key === 'P') { ampmEl.textContent = 'PM'; e.preventDefault(); fireChange(); }
    if (e.key === 'Tab') return;
  });
}

// ── PST helpers ────────────────────────────────────────────────────────────

export function getPST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

export function dateToMinsPST(date) {
  const p = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return p.getHours() * 60 + p.getMinutes();
}

export function parseDateLocalMins(dtStr) {
  if (!dtStr) return null;
  const m = dtStr.match(/T(\d{2}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return dateToMinsPST(new Date(dtStr));
}

export function fmtTimePST(dtStr) {
  if (!dtStr) return null;
  const tm = typeof dtStr === 'string' ? dtStr.match(/T(\d{2}):(\d{2})/) : null;
  if (tm) {
    let h = parseInt(tm[1], 10), m = parseInt(tm[2], 10);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${pad2(m)}${ap}`;
  }
  const d = new Date(dtStr);
  if (isNaN(d)) return null;
  const p = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  let h = p.getHours(), m = p.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${pad2(m)}${ap}`;
}

export function msMinsToCalMins(ms) {
  const p = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return p.getHours() * 60 + p.getMinutes();
}

export function todayPstDateStr() {
  const p = getPST();
  return `${p.getFullYear()}-${pad2(p.getMonth()+1)}-${pad2(p.getDate())}`;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function fmtMins(m) {
  const clamped = Math.max(0, Math.min(m, 1439));
  return `${pad2(Math.floor(clamped/60))}:${pad2(clamped%60)}`;
}

export function fmtBudgetMins(mins) {
  return mins >= 60 && mins % 60 === 0 ? `${mins / 60} hr` : `${mins} min`;
}

// ── End-time helpers ───────────────────────────────────────────────────────

export function minsUntil(dtStr) {
  if (!dtStr) return null;
  const d = new Date(dtStr);
  if (isNaN(d)) return null;
  return (d - new Date()) / 60000;
}

export function fmtEndTime(dtStr) {
  if (!dtStr) return null;
  const mins = minsUntil(dtStr);
  if (mins === null) return null;
  const label = fmtTimePST(dtStr);
  if (mins < -60)  return `ends ${label} (overdue)`;
  if (mins < 0)    return `ends ${label} (${Math.abs(Math.round(mins))}m past)`;
  if (mins < 60)   return `ends ${label} (${Math.round(mins)}m left)`;
  return `ends ${label}`;
}

export function endTimeClass(dtStr) {
  const mins = minsUntil(dtStr);
  if (mins === null) return '';
  if (mins < 0)    return 'end-over';
  if (mins <= 30)  return 'end-urgent';
  if (mins <= 60)  return 'end-warn';
  return '';
}

export function fmtDuration(mins) {
  if (!mins) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), rm = mins % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// ── General utilities ──────────────────────────────────────────────────────

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function timeAgo(ts) {
  const diffMins = Math.floor((Date.now() - ts) / 60000);
  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  return diffHours < 24 ? `${diffHours}h ago` : `${Math.floor(diffHours / 24)}d ago`;
}

export function fmtTaskMins(mins) {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60), remainder = mins % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

// ── Clock display ──────────────────────────────────────────────────────────
// updateClock is defined in categories.js (it calls renderCategoryTally).
// This helper is used by categories.js to render the clock digits.
export function renderClockDisplay() {
  const tz = state.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  let h = now.getHours();
  const m = now.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  document.getElementById('clockTime').textContent = `${h}:${pad2(m)}`;
  document.getElementById('clockAmpm').textContent = ap;
  document.getElementById('clockDate').textContent =
    `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  const short = new Date().toLocaleTimeString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
  const tzEl = document.getElementById('clockTz');
  if (tzEl) tzEl.textContent = short;
  const mobileClockEl = document.getElementById('mobileClock');
  if (mobileClockEl) mobileClockEl.textContent = `${h}:${pad2(m)} ${ap} ${short}`;
}
