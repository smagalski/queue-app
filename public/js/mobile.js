import { state } from './state.js';
import { fmtDuration } from './utils.js';
import { save } from './persistence.js';
import { render, isScheduled } from './render.js';
import { renderCalendar } from './calendar.js';
import { deleteTaskById } from './taskactions.js';

// ── View mode (mobile / desktop) ───────────────────────────────────────────

export function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 600;
}

export function applyViewMode(mobile) {
  const segDesktop = document.getElementById('segDesktop');
  const segMobile  = document.getElementById('segMobile');
  if (mobile) {
    document.body.classList.add('mobile-view');
    if (segDesktop) segDesktop.classList.remove('active');
    if (segMobile)  segMobile.classList.add('active');
  } else {
    document.body.classList.remove('mobile-view');
    closeCalDrawer();
    if (segDesktop) segDesktop.classList.add('active');
    if (segMobile)  segMobile.classList.remove('active');
  }
}

// ── Calendar drawer (mobile only) ─────────────────────────────────────────

export function toggleCalDrawer(e) {
  if (!document.body.classList.contains('mobile-view')) return;
  e.stopPropagation();
  if (document.body.classList.contains('cal-drawer-open')) {
    closeCalDrawer();
  } else {
    openCalDrawer();
  }
}

export function openCalDrawer() {
  // Move calContainer into the drawer panel
  const container = document.getElementById('calContainer');
  const panel     = document.getElementById('calDrawerPanel');
  if (container && panel && !panel.contains(container)) {
    panel.appendChild(container);
  }
  document.body.classList.add('cal-drawer-open');
  renderCalendar(); // re-render inside drawer
}

export function closeCalDrawer() {
  // Move calContainer back into calendar-section
  const container = document.getElementById('calContainer');
  const section   = document.getElementById('calendarSection');
  if (container && section && !section.contains(container)) {
    section.appendChild(container);
  }
  document.body.classList.remove('cal-drawer-open');
}

// ── Pull-to-refresh (mobile only) ─────────────────────────────────────────

(function initPullToRefresh() {
  const PTR_THRESHOLD = 72;   // pull distance (px) required to trigger
  const PTR_MAX       = 88;   // max indicator travel (px)
  const PTR_DAMPING   = 0.45; // resistance: finger travel → indicator travel
  const EL_H          = 36;   // indicator circle height (matches CSS)

  const el    = document.getElementById('ptr');
  const arrow = document.getElementById('ptrArrow');
  const spin  = document.getElementById('ptrSpinner');

  let touchStartY = null;
  let pulling     = false;
  let triggered   = false;

  function ptrReset() {
    el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    el.style.transform  = 'translate(-50%, -100%)';
    el.style.opacity    = '0';
    setTimeout(() => {
      el.style.transition   = '';
      el.style.opacity      = '';
      arrow.style.transform = '';
      arrow.style.display   = '';
      spin.style.display    = 'none';
      triggered = false;
    }, 260);
  }

  document.addEventListener('touchstart', e => {
    if (!document.body.classList.contains('mobile-view')) return;
    if (window.scrollY > 4 || triggered) return;
    touchStartY = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (touchStartY === null || triggered) return;
    const dy = e.touches[0].clientY - touchStartY;
    if (dy <= 0) { touchStartY = null; return; }

    pulling = true;
    e.preventDefault();

    const damped = Math.min(dy * PTR_DAMPING, PTR_MAX);
    el.style.transition = 'none';
    el.style.transform  = `translate(-50%, ${-EL_H + damped}px)`;
    el.style.opacity    = String(Math.min(damped / 28, 1));

    // Arrow rotates as you pull, flips at threshold
    arrow.style.transform = dy >= PTR_THRESHOLD
      ? 'rotate(180deg)'
      : `rotate(${(dy / PTR_THRESHOLD) * 180}deg)`;
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (!pulling || triggered) { touchStartY = null; pulling = false; return; }
    const dy = e.changedTouches[0].clientY - (touchStartY || 0);
    touchStartY = null;
    pulling = false;

    if (dy >= PTR_THRESHOLD) {
      triggered = true;
      // Lock indicator visible and swap to spinner
      const lockY = Math.min(dy * PTR_DAMPING, PTR_MAX) - EL_H;
      el.style.transition = 'transform 0.15s ease';
      el.style.transform  = `translate(-50%, ${Math.min(lockY, PTR_MAX * 0.5)}px)`;
      el.style.opacity    = '1';
      arrow.style.display = 'none';
      spin.style.display  = 'block';
      // Trigger a reload via window global (persistence.load wired in main.js)
      window.load?.();
      setTimeout(ptrReset, 1000);
    } else {
      ptrReset();
    }
  }, { passive: true });
})();

// ── Mobile tab navigation ──────────────────────────────────────────────────

let _mobileCurrentPanel = 'queue';

export function showMobilePanel(panel) {
  _mobileCurrentPanel = panel;
  const layout    = document.querySelector('.main-layout');
  const btnTl     = document.getElementById('mobileNavTimeline');
  const btnQ      = document.getElementById('mobileNavQueue');
  const leftPanel = document.querySelector('.left-panel');

  if (panel === 'timeline') {
    // Ensure calContainer is in calendarSection, not the hidden drawer panel
    const container = document.getElementById('calContainer');
    const calSec    = document.getElementById('calendarSection');
    if (container && calSec && !calSec.contains(container)) {
      calSec.appendChild(container);
      document.body.classList.remove('cal-drawer-open');
      renderCalendar();
    }
    layout.classList.add('show-timeline');
    if (btnTl) btnTl.classList.add('active');
    if (btnQ)  btnQ.classList.remove('active');
    // Scroll timeline to centre the now-line
    if (leftPanel) {
      const nowLine = document.querySelector('.cal-now-line');
      if (nowLine) {
        const nowTop = nowLine.offsetTop;
        const viewH  = leftPanel.clientHeight;
        leftPanel.scrollTop = Math.max(0, nowTop - viewH / 2);
      }
    }
  } else {
    layout.classList.remove('show-timeline');
    if (btnQ)  btnQ.classList.add('active');
    if (btnTl) btnTl.classList.remove('active');
  }
}

// ── Mobile FAB / Action Sheet ──────────────────────────────────────────────

export function openMobileAddSheet() {
  // Mirror disabled state of the main Take a Break button
  const src = document.getElementById('takeBreakBtn');
  const mas = document.getElementById('masBreakBtn');
  if (src && mas) {
    mas.disabled = src.disabled;
  }
  document.getElementById('mobileActionSheetOverlay').classList.add('open');
}

export function closeMobileAddSheet() {
  document.getElementById('mobileActionSheetOverlay').classList.remove('open');
}

// ── Mobile task-edit sheet ─────────────────────────────────────────────────

let _mobileEditTaskId = null;

export function openMobileTaskEdit(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  _mobileEditTaskId = taskId;

  const isBreak = !!task.isBreak;
  const isSched = isScheduled(task);

  // Show/hide sections based on task type
  document.getElementById('mteTitleSection').style.display    = isBreak ? 'none' : '';
  document.getElementById('mtePrioritySection').style.display = (isBreak || isSched) ? 'none' : '';
  document.getElementById('mteDurSection').style.display      = isBreak ? 'none' : '';

  if (!isBreak) {
    document.getElementById('mteTitle').value    = task.title;
    document.getElementById('mteDuration').value = task.duration ? fmtDuration(task.duration) : '';
  }
  if (!isBreak && !isSched) {
    mteSelectPriority(task.priority || 3);
  }
  document.getElementById('mobileTaskEditOverlay').classList.add('open');
  if (!isBreak) setTimeout(() => document.getElementById('mteTitle').focus(), 320);
}

export function closeMobileTaskEdit() {
  document.getElementById('mobileTaskEditOverlay').classList.remove('open');
  _mobileEditTaskId = null;
}

export function mteSelectPriority(p) {
  document.querySelectorAll('.mte-p-btn').forEach(btn => {
    const bp = parseInt(btn.dataset.p);
    btn.className = 'mte-p-btn' + (bp === p ? ` mte-active-${p}` : '');
  });
}

export function saveMobileTaskEdit() {
  const task = state.tasks.find(t => t.id === _mobileEditTaskId);
  if (!task) { closeMobileTaskEdit(); return; }

  const title = document.getElementById('mteTitle').value.trim();
  if (title && title !== task.title) {
    task.title = title;
    delete task.categoryOverride;
  }

  const activeBtn = document.querySelector('.mte-p-btn[class*="mte-active-"]');
  if (activeBtn) task.priority = parseInt(activeBtn.dataset.p);

  const durStr = document.getElementById('mteDuration').value.trim();
  if (durStr) {
    const parsed = _parseMteDuration(durStr);
    if (parsed > 0) task.duration = parsed;
  }

  save(); render(); closeMobileTaskEdit();
}

export function deleteMobileTask() {
  if (_mobileEditTaskId !== null) {
    deleteTaskById(_mobileEditTaskId);
    closeMobileTaskEdit();
  }
}

function _parseMteDuration(s) {
  s = s.toLowerCase().replace(/\s+/g, '');
  let total = 0;
  const hm = s.match(/(\d+(?:\.\d+)?)[h]/);
  const mm = s.match(/(\d+)[m]/);
  if (hm) total += Math.round(parseFloat(hm[1]) * 60);
  if (mm) total += parseInt(mm[1]);
  if (!hm && !mm) { const n = parseInt(s); if (n > 0) total = n; }
  return total;
}

// ── Swipe left/right to switch panels ─────────────────────────────────────

(function setupMobileSwipe() {
  let startX = 0, startY = 0, startTime = 0;
  const layout = document.querySelector('.main-layout');
  if (!layout) return;
  layout.addEventListener('touchstart', e => {
    startX    = e.touches[0].clientX;
    startY    = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });
  layout.addEventListener('touchend', e => {
    if (!document.body.classList.contains('mobile-view')) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dt = Date.now() - startTime;
    if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 48 && dt < 400) {
      if (dx < 0 && _mobileCurrentPanel === 'timeline') showMobilePanel('queue');
      if (dx > 0 && _mobileCurrentPanel === 'queue')    showMobilePanel('timeline');
    }
  }, { passive: true });
})();

// ── Init view mode ─────────────────────────────────────────────────────────

(function initViewMode() {
  const mobile = isMobileDevice();
  applyViewMode(mobile);
  if (mobile) {
    showMobilePanel('queue');
    const vs = document.getElementById('viewSegment');
    if (vs) vs.style.display = 'none';
  }
})();

// ── Tauri overlay mode ─────────────────────────────────────────────────────

let _overlayEnabled = false;

(function initTauriMode() {
  if (!window.__TAURI__) return;

  // Hide the desktop/mobile view toggle — not needed in the Mac app
  const vs = document.getElementById('viewSegment');
  if (vs) vs.style.display = 'none';

  // Show the overlay toggle
  const wrap = document.getElementById('overlayToggleWrap');
  if (wrap) wrap.style.display = 'flex';

  // Restore saved preference and sync checkbox
  _overlayEnabled = localStorage.getItem('overlayMode') === '1';
  const input = document.getElementById('overlayToggleInput');
  if (input) input.checked = _overlayEnabled;

  // When the main window is minimized, show overlay if enabled
  window.__TAURI__.event.listen('main-window-minimized', async () => {
    if (_overlayEnabled) {
      try {
        const saved = localStorage.getItem('q_overlay_pos');
        const pos   = saved ? JSON.parse(saved) : {};
        await window.__TAURI__.core.invoke('show_overlay', { x: pos.x ?? null, y: pos.y ?? null });
      } catch (e) { console.error(e); }
    }
  });
})();

export function overlayModeChanged(enabled) {
  _overlayEnabled = enabled;
  localStorage.setItem('overlayMode', enabled ? '1' : '0');
  if (!enabled && window.__TAURI__) {
    window.__TAURI__.core.invoke('hide_overlay').catch(() => {});
  }
}

// ── Populate duration selects ──────────────────────────────────────────────

(function populateDurationSelects() {
  const DURATION_OPTS = [
    [15,'15 min'],[30,'30 min'],[45,'45 min'],[60,'1 hr'],
    [90,'1 hr 30 min'],[120,'2 hr'],[150,'2 hr 30 min'],[180,'3 hr'],
    [240,'4 hr'],[300,'5 hr'],[360,'6 hr'],[480,'8 hr'],
  ];
  const html = DURATION_OPTS.map(([v,l]) => `<option value="${v}"${v===60?' selected':''}>${l}</option>`).join('');
  ['durationInput','schedDurInput','sdDurInput','ddDurInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
})();
