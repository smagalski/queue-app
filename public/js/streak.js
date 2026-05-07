import { state } from './state.js';
import { todayPstDateStr, pad2 } from './utils.js';

// ── Streak counter ─────────────────────────────────────────────────────────

let _streakCount = 0;

/** Returns the ISO date string for the day before dateStr. */
export function prevDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * Queries Firestore for the last 90 history docs and counts consecutive
 * days that were ended, marked day-off, or marked not-tracked.
 * Today counts if q_dayEnded or q_dayOff is set in localStorage.
 */
export async function computeStreak() {
  if (!state.db || !state.currentUser) return 0;
  const snap = await state.db.collection('users').doc(state.currentUser.uid)
    .collection('history').orderBy('date', 'desc').limit(90).get();
  const histMap = {};
  for (const doc of snap.docs) histMap[doc.data().date] = doc.data();
  const today       = todayPstDateStr();
  const todayEnded  = localStorage.getItem('q_dayEnded') === today;
  const todayDayOff = localStorage.getItem('q_dayOff')   === today;
  let count  = 0;
  let cursor = (todayEnded || todayDayOff) ? today : prevDateStr(today);
  while (true) {
    const day = histMap[cursor];
    if (!day) break;
    if (!day.dayEnded && !day.dayOff && !day.dayNotTracked) break;
    count++;
    cursor = prevDateStr(cursor);
  }
  return count;
}

/** Updates the streak widget DOM with the given count. */
export function renderStreak(count) {
  _streakCount = count;
  const widget = document.getElementById('streakWidget');
  if (!widget) return;
  if (count < 1) { widget.style.display = 'none'; return; }
  widget.style.display = '';
  document.getElementById('streakCount').textContent = count;
}

/** Re-computes and re-renders the streak widget. */
export function refreshStreak() {
  computeStreak().then(renderStreak).catch(() => {});
}

/** Returns the last-computed streak count synchronously (for the wizard prompt). */
export function getStreakCount() { return _streakCount; }
