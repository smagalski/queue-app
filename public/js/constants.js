export const DONE_TTL    = 48 * 60 * 60 * 1000;
export const DEFAULT_DUR = 60;

export const P_LABELS = ['','URGENT','HIGH','MEDIUM','LOW'];
export const P_COLORS = ['','#ff6b8a','#ffaa60','#f0d060','#7fd4a8'];
export const P_NAMES  = ['','Urgent','High','Medium','Low'];
export const P_COLS   = ['','rgba(255,107,138,0.2)','rgba(255,170,96,0.2)','rgba(240,208,96,0.2)','rgba(127,212,168,0.2)'];
export const P_TEXT   = ['','#ff6b8a','#ffaa60','#f0d060','#7fd4a8'];

export const DAYS           = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const MONTHS         = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const RECUR_DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export const SCHED_COL = '#7ec8e3';

export const CAT_TALLY_COLORS = ['#7ec8e3','#9863f3','#f0d060','#7fd4a8','#ffaa60','#ff6b8a'];

export const STRESS_DEFAULTS = { hours: 6, volume: 2, urgency: 1 };

export const APP_VERSION  = '0.1.20';
export const APP_DEPLOYED = 'May 7, 2026';
export const APP_CHANGES  = [
  'Fixed auto-updater dialog not appearing on launch',
  'Streak counter now updates correctly after ending, resuming, or wrapping up a day',
  'Wrap-up prompt shows your current streak as motivation to finish',
  'Refactored codebase into shared CSS and JS modules',
];

export const GCAL_CLIENT_ID = '98725644783-jrc447s324kbmc1060c8ic5f7crm75js.apps.googleusercontent.com';
export const GCAL_DESKTOP_CLIENT_ID     = '98725644783-r90816344btp09thpk53p4p99pqd0ts3.apps.googleusercontent.com';
export const GCAL_DESKTOP_CLIENT_SECRET = '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';

export const firebaseConfig = {
  apiKey:            'AIzaSyCRyndKjysAz6HxdZ4WF14kt2Ru9M2iqv0',
  authDomain:        'queue-app-smagalski.firebaseapp.com',
  projectId:         'queue-app-smagalski',
  storageBucket:     'queue-app-smagalski.firebasestorage.app',
  messagingSenderId: '98725644783',
  appId:             '1:98725644783:web:24fa7a7d267c39b7728e1a',
};

export const DEFAULT_CATEGORY_RULES = [
  { id: 'chores', name: 'Chores & Errands',
    keywords: ['chores','errands','groceries','laundry','dishes','clean','vacuum','trash','errand','pickup',
               'drop off','pharmacy','target','store','shop','mail','bank','gas','appointment',
               'house','yardwork','yard','lawn'] },
  { id: 'work',   name: 'Work',
    keywords: ['work','meeting','call','email','client','invoice','edit','shoot','review','submit',
               'schedule','film','record','prep','script','plan','produce','sync','pitch','budget','hire'] },
  { id: 'other',  name: 'Other', keywords: [] },
];
