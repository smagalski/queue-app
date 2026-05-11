export const state = {
  // Task data
  tasks: [], doneTasks: [], recurringTasks: [], categoryRules: [],

  // Firebase handles (set once on auth)
  db: null, auth: null, currentUser: null, stateDoc: null,
  unsubscribeSnapshot: null, listenerRetryTimer: null,

  // Calendar bounds (mutable, persisted to localStorage)
  calStart: parseInt(localStorage.getItem('q_calStart') || '360'),
  calEnd:   parseInt(localStorage.getItem('q_calEnd')   || '1260'),
  pxPerMin: 44 / 60,

  // Break feature
  breakBudgetMins: 60, breakUsedMins: 0, breakDay: null,
  breakStartMs: null, breakTimerInt: null, breakTaskId: null,
  autoBreakAfterTask: false, autoBreakMins: 5,
  breakIsAuto: false, autoBreakPrompting: false,
  suppressAutoBreakBefore: new Set(),
  forceBreakBefore: new Set(),

  // Drag & drop
  dragId: null, calDrag: null,

  // Dropdown edit targets
  pdTargetId: null, cdTargetId: null,
  sdTargetId: null, sdAnchor: 'start',
  ddTargetId: null, stTargetId: null,

  // Render flags
  currentNowId: null,
  doneOpen: false, addOpen: false, schedOpen: false, moreOpen: false,

  // Form transient state
  selPriority: null, schedAnchor: 'start',
  selectedRecurringDays: new Set(),

  // Sync toggle (authenticated users can disable Firestore sync)
  syncEnabled: true,

  // Timezone (IANA string; defaults to device TZ, persisted per-uid)
  timezone: '',
};
