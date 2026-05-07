// ── Imports ────────────────────────────────────────────────────────────────

import { state } from './state.js';

// utils
import { initSmartTime } from './utils.js';

// persistence
import { registerPersistenceHooks, load, save, openRecurringOverlay, closeRecurringOverlay, deleteRecurring, openEditRecurring, cancelEditRecurring, saveEditRecurring } from './persistence.js';

// render
import { setRenderHooks, render, closeBlockDetail, deleteBlockFromDetail, updateDoneBlockTime, startDoneTitleEdit } from './render.js';

// calendar
import { renderCalendar, updateCalNowLine, setCalBounds, loadCalBounds } from './calendar.js';

// taskactions
import {
  setAfterAddHook, hideAllDropdowns,
  showPriorityDropdown, changeTaskPriority,
  showCategoryDropdown, changeTaskCategory,
  showSchedDropdown, hideSchedDropdown, sdSetAnchor, sdCheckSave, commitSchedEdit, convertToFlex,
  showDurDropdown, commitDurEdit,
  showStartTimeDropdown, commitStartTimeEdit,
  openAddForm, closeAddForm, selectP, checkAdd, addTask,
  setAnchor, openSchedForm, closeSchedForm, checkSchedAdd,
  toggleRecurringDays, toggleRecurringDay, addScheduledTask,
  toggleMore,
  cardDragStart, cardDragEnd, schedDragAttempt,
  slotDragOver, slotDragLeave, slotDrop,
  moreDragOver, moreDragLeave, moreDrop, moreCardDragOver, moreCardDrop,
  deleteTaskById, markDoneById, unmarkDone, undoLastAction, toggleDone, startTitleEdit,
} from './taskactions.js';

// breaks
import {
  loadBreakState, setAutoBreakAfterTask, setAutoBreakMins, setBreakBudget,
  takeBreak, startAutoBreak, skipAutoBreak, endBreak, updateBreakTimer, updateBreakUI,
} from './breaks.js';

// sidequest
import { openSidequest, endSidequest, _afterAddFlexTask } from './sidequest.js';

// endday
import {
  openEndDayModal, closeEndDayModal,
  edmDragStart, edmDragEnd, edmDragOver, edmDragLeave, edmDrop,
  commitEndDay, updateTodayHistory, resumeDay,
  checkDayEndedReset, checkDayEndedFirestore,
  showDayOffOverlay, enterDayOff, cancelDayOff, checkDayOffState, checkDayOffFirestore,
  openHistoryOverlay, closeHistoryOverlay,
  hdcDragStart, hdcDragEnd, hdcDragOver, hdcDragLeave, hdcDrop,
} from './endday.js';

// categories
import {
  updateClock, renderCategoryTally,
  onStressCatToggle, onStressSlider, resetStressWeights,
  renderCategoryManager, addCategoryKeyword, removeCategoryKeyword, addCategory, deleteCategory,
  showConfirmClear7, hideConfirmClear7, showConfirmClearAll, hideConfirmClearAll,
  clearOldHistory, clearAllHistory,
} from './categories.js';

// gcal
import {
  dismissGcalDailyPrompt, openGcalImport,
  toggleGcalRow, updateGcalRow, importGcalTasks, closeGcalLightbox,
} from './gcal.js';

// firebase
import {
  initAuth, toggleAuthMode, submitAuth, signInWithGoogle, signOut,
  toggleGearMenu, closeGearMenu, openSettings, closeSettings, switchSettingsTab,
  checkForUpdates, closePasswordModal, submitPasswordModal, submitResetPassword,
} from './firebase.js';

// wrapup
import {
  closeWrapUpPrompt, markDayResolvedFromPrompt, openWrapUpWizard, commitWrapUp,
  _wupGoBack, _wupBackInTask, _wupAdvance, _wupResolveOlderDay,
  _wupAnswerTask, _wupSubmitFinishTime, _wupAnswerCarry,
  _wupOpenAddForm, _wupCancelAddForm, _wupSubmitAddTask, _wupRemoveAdded, _wupMaybeLater,
} from './wrapup.js';

// streak
import { refreshStreak } from './streak.js';

// mobile
import {
  applyViewMode, toggleCalDrawer, showMobilePanel,
  openMobileAddSheet, closeMobileAddSheet,
  openMobileTaskEdit, closeMobileTaskEdit, mteSelectPriority, saveMobileTaskEdit, deleteMobileTask,
  overlayModeChanged,
} from './mobile.js';

// ── Wire hooks ─────────────────────────────────────────────────────────────

// persistence ← render, updateTodayHistory, updateBreakTimer, updateBreakUI
registerPersistenceHooks({ render, updateTodayHistory, updateBreakTimer, updateBreakUI });

// render ← renderCalendar, updateBreakUI
setRenderHooks({ renderCalendar, updateBreakUI });

// taskactions ← _afterAddFlexTask (sidequest)
setAfterAddHook(_afterAddFlexTask);

// ── Expose window globals (for inline onclick="" attributes) ───────────────

Object.assign(window, {
  // persistence
  load, save,
  openRecurringOverlay, closeRecurringOverlay, deleteRecurring,
  openEditRecurring, cancelEditRecurring, saveEditRecurring,

  // render
  render,
  closeBlockDetail, deleteBlockFromDetail, updateDoneBlockTime, startDoneTitleEdit,

  // calendar
  renderCalendar, setCalBounds, loadCalBounds, updateCalNowLine,

  // taskactions
  hideAllDropdowns,
  showPriorityDropdown, changeTaskPriority,
  showCategoryDropdown, changeTaskCategory,
  showSchedDropdown, hideSchedDropdown, sdSetAnchor, sdCheckSave, commitSchedEdit, convertToFlex,
  showDurDropdown, commitDurEdit,
  showStartTimeDropdown, commitStartTimeEdit,
  openAddForm, closeAddForm, selectP, checkAdd, addTask,
  setAnchor, openSchedForm, closeSchedForm, checkSchedAdd,
  toggleRecurringDays, toggleRecurringDay, addScheduledTask,
  toggleMore,
  cardDragStart, cardDragEnd, schedDragAttempt,
  slotDragOver, slotDragLeave, slotDrop,
  moreDragOver, moreDragLeave, moreDrop, moreCardDragOver, moreCardDrop,
  deleteTaskById, markDoneById, unmarkDone, undoLastAction, toggleDone, startTitleEdit,

  // breaks
  setAutoBreakAfterTask, setAutoBreakMins, setBreakBudget,
  takeBreak, startAutoBreak, skipAutoBreak, endBreak,

  // sidequest
  openSidequest, endSidequest,

  // endday
  openEndDayModal, closeEndDayModal,
  edmDragStart, edmDragEnd, edmDragOver, edmDragLeave, edmDrop,
  commitEndDay, resumeDay,
  showDayOffOverlay, enterDayOff, cancelDayOff,
  openHistoryOverlay, closeHistoryOverlay,
  hdcDragStart, hdcDragEnd, hdcDragOver, hdcDragLeave, hdcDrop,

  // categories
  updateClock, renderCategoryTally,
  onStressCatToggle, onStressSlider, resetStressWeights,
  renderCategoryManager, addCategoryKeyword, removeCategoryKeyword, addCategory, deleteCategory,
  openCategoryManager: () => openSettings('categories'),
  closeCategoryManager: () => closeSettings(),
  showConfirmClear7, hideConfirmClear7, showConfirmClearAll, hideConfirmClearAll,
  clearOldHistory, clearAllHistory,
  openClearHistoryConfirm: () => openSettings('data'),
  closeClearHistoryConfirm: () => closeSettings(),

  // gcal
  dismissGcalDailyPrompt, openGcalImport,
  toggleGcalRow, updateGcalRow, importGcalTasks, closeGcalLightbox,

  // firebase / auth
  toggleAuthMode, submitAuth, signInWithGoogle, signOut,
  toggleGearMenu, closeGearMenu, openSettings, closeSettings, switchSettingsTab,
  checkForUpdates, closePasswordModal, submitPasswordModal, submitResetPassword,

  // streak
  refreshStreak,

  // wrapup
  closeWrapUpPrompt, markDayResolvedFromPrompt, openWrapUpWizard, commitWrapUp,
  _wupGoBack, _wupBackInTask, _wupAdvance, _wupResolveOlderDay,
  _wupAnswerTask, _wupSubmitFinishTime, _wupAnswerCarry,
  _wupOpenAddForm, _wupCancelAddForm, _wupSubmitAddTask, _wupRemoveAdded, _wupMaybeLater,

  // mobile
  applyViewMode, toggleCalDrawer, showMobilePanel,
  openMobileAddSheet, closeMobileAddSheet,
  openMobileTaskEdit, closeMobileTaskEdit, mteSelectPriority, saveMobileTaskEdit, deleteMobileTask,
  overlayModeChanged,
});

// ── Global event listeners ─────────────────────────────────────────────────

// Close gear menu on outside click
document.addEventListener('click', e => {
  const gear = document.getElementById('gearMenu');
  const btn  = document.getElementById('gearBtn');
  if (gear && gear.classList.contains('open') && !gear.contains(e.target) && e.target !== btn) {
    closeGearMenu();
  }
});

// Escape key: close modals / dropdowns / overlays
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  hideAllDropdowns();
  closeGearMenu();
  // Close any open overlay that has a dismiss button/class
  ['addForm', 'schedForm', 'sidequestOverlay', 'breakOverlay',
   'endDayOverlay', 'dayOffOverlay', 'historyOverlay',
   'gcalOverlay', 'mobileActionSheetOverlay', 'mobileTaskEditOverlay',
   'blockDetailOverlay',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el && (el.classList.contains('active') || el.classList.contains('open'))) {
      el.classList.remove('active', 'open');
    }
  });
});

// ── Intervals ──────────────────────────────────────────────────────────────

setInterval(updateClock, 1000);
// Move now-line every minute without rebuilding the calendar
setInterval(updateCalNowLine, 60000);
// Full re-render every 30s (for time labels, escalation, etc.)
setInterval(render, 30000);
// Check day-ended reset every minute (catches midnight rollover)
setInterval(checkDayEndedReset, 60000);
// Check day-off state every minute
setInterval(checkDayOffState, 60000);

// Re-render calendar on window resize so timeline scales to available height
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => renderCalendar(), 100);
});

// ── Init sequence ──────────────────────────────────────────────────────────

// Wire Firebase auth (sets state.auth, calls load() on sign-in)
initAuth();

// If Firebase auth is unavailable (offline / no auth configured), load locally
if (!state.auth) { load(); }

// Break state from localStorage
loadBreakState();

// Calendar time range selectors
loadCalBounds();

// Smart time pickers
initSmartTime('schedTimeInput');
initSmartTime('sdTimeInput');

// Day-ended / day-off state
checkDayEndedReset();
checkDayOffState();

// Initial render + clock
updateClock();
render();
