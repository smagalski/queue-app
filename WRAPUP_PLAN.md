# Feature Plan: Previous Day Wrap-Up

## Overview

If a user did not formally end the previous day (no `dayEnded`, `dayOff`, or `dayNotTracked` on the history record), the app prompts them on first login of the new day to wrap up. The goal is to help users keep their day history accurate without creating "tracking overwhelm" — every step should feel like a helpful nudge, not a chore.

---

## Codebase Context

- **Stack**: Vanilla JS, HTML, CSS — single large file at `public/index.html` (~7155 lines)
- **Auth/DB**: Firebase Auth + Firestore
- **State**: localStorage for offline cache, Firestore real-time listener for sync
- **Timezone**: All dates/times use PST (Los Angeles). Key helpers: `getPST()`, `todayPstDateStr()`, `parseDateLocalMins()`, `msMinsToCalMins()`
- **History**: Firestore path `users/{uid}/history/{YYYY-MM-DD}`
- **App load entry point**: `_enterApp(user)` → calls `load()`, `checkDayOffFirestore()`, `checkDayEndedFirestore()`, `maybeShowGcalDailyPrompt()`
- **Modal pattern**: Fixed overlay div + inner modal div. Toggle `.active` class to show/hide. Backdrop click closes. See `#endDayOverlay`, `#dayOffOverlay` for reference.
- **Calendar rendering**: `renderCalendar()` renders the visual timeline. The wrap-up timeline should use the same visual logic, read-only, seeded with history data.

---

## Trigger Logic

### New function: `checkPreviousDayWrapUp()`

Call this from `_enterApp()` after all existing checks complete.

**Show the prompt if ALL of the following are true:**
1. `q_wrapup_prompt_date` in localStorage does NOT equal today's PST date
2. At least one past day (yesterday or earlier) has a Firestore `history/{date}` record where `dayEnded`, `dayOff`, and `dayNotTracked` are all falsy — OR — has no history record at all

**"Maybe later" behavior**: Does NOT set `q_wrapup_prompt_date`. Prompt re-appears on next login.

**All other choices**: Set `q_wrapup_prompt_date = todayPstDateStr()` immediately. Prompt does not re-fire that calendar day.

### New localStorage key

| Key | Value | Purpose |
|---|---|---|
| `q_wrapup_prompt_date` | `"YYYY-MM-DD"` | Suppresses re-prompt on same calendar day after any decisive action |

---

## Stage 1 — Initial Prompt

### Element: `#wrapUpPromptOverlay`

Small centered modal, same style as `#dayOffOverlay`.

**Content:**
```
You didn't finish tracking yesterday (Mon, Apr 28).
Would you like to wrap up?

  [Yes, let's wrap up]
  [Mark as Day Off]
  [Mark as Workday (not tracked)]
  [Maybe later]
```

Show this prompt even if there is NO history record for yesterday (user never opened the app that day) — "Day Off" and "Workday (not tracked)" are still valid and useful options.

**Button actions:**

- **Yes, let's wrap up** → set `q_wrapup_prompt_date = today`, open wizard (`openWrapUpWizard()`)
- **Mark as Day Off** → call `markDayResolved(yesterday, 'dayOff')`, set `q_wrapup_prompt_date = today`, close
- **Mark as Workday (not tracked)** → call `markDayResolved(yesterday, 'dayNotTracked')`, set `q_wrapup_prompt_date = today`, close
- **Maybe later** → close only, no localStorage write

---

## Stage 2 — Wrap-Up Wizard

### Element: `#wrapUpOverlay`

Wider modal (~680px), two-panel layout, consistent styling with rest of app.

**Left panel — Live Timeline**
- Renders the previous day's calendar using the same visual logic as the main app (`renderCalendar()`)
- Read-only version, seeded with `history/{yesterday}` data (`doneTasks` + `incompleteTasks`)
- Updates live after every answered question or added task

**Right panel — Wizard steps**
- One question/step at a time
- Progress indicator at top (e.g., "Step 2 of 5")
- Back / Next navigation

---

## Wizard Step Sequence

### Pre-step: Older incomplete days (if any exist beyond yesterday)

Before the main wizard, handle any days older than yesterday that are also incomplete. One screen per day, in reverse chronological order:

```
Monday, Apr 27 has no recorded activity.

  [Day Off]   [Workday (not tracked)]   [Skip for now]
```

- **Day Off** / **Workday (not tracked)** → call `markDayResolved(date, type)`, advance to next older day or into main wizard
- **Skip for now** → advance without writing anything

---

### Step A — Incomplete tasks

**One screen per task** in `incompleteTasks` from yesterday's history.

```
Did you complete "[Task Name]"?
It started around 3:00 PM.

  [Yes]   [No]
```

- **Yes** → follow-up: "When did you finish?" (time picker, PST, constrained to yesterday). Task added to `doneTasks` with that `doneAt` timestamp.
- **No** → follow-up: "Do you want to add this to today's queue?" (Yes / No). If Yes, task is added to the current `tasks` array on commit.

**If there are no `incompleteTasks`**: Skip Step A. Show a brief acknowledgment instead:
```
Looks like all your tasks were completed.
Anything else you'd like to add from yesterday?
```
Then go directly to Step B.

---

### Step B — Open-ended add

```
Were there any other tasks from yesterday not shown on the timeline?

  [+ Add a task]   [No, I'm done]
```

**"+ Add a task"** opens an inline simplified add form (see below). User can add multiple tasks. Timeline updates after each addition. When done adding, they continue to Step C.

**Simplified retroactive task form fields:**
- Title (text input)
- Category (dropdown — uses existing `categoryRules` categories)
- Start time (time picker, constrained to yesterday, PST)
- End time (time picker, must be after start time)

Duration is calculated from start/end. No priority field.

---

### Step C — Review & confirm

Final step. Right panel shows a brief summary of changes. Left panel shows the completed updated timeline.

```
Here's your updated day for Mon, Apr 28:

  • Design review — 10:00 AM – 11:30 AM  ✓ completed
  • Code task — 1:00 PM – 3:00 PM  ✓ completed
  • Client call — 3:00 PM (added)

  [Save & Close]   [Go back]
```

**Save & Close** calls `commitWrapUp()`.

---

## Data Writes

### `commitWrapUp(date, amendments)`

Writes to Firestore `history/{yesterday}`:

```javascript
{
  // All existing fields preserved
  doneTasks: [...originalDoneTasks, ...newlyCompletedTasks, ...retroAddedTasks],
  incompleteTasks: [...acknowledgedIncompleteTasks],
  taskCategoryOverrides: { ...existing, ...newOverridesFromRetroTasks },
  dayEnded: true,
  wrapUpCompleted: true,
  wrapUpSavedAt: Timestamp.now(),
  // Recalculated from updated task list:
  stressScore: recalculatedScore,
  priorityBreakdown: recalculatedBreakdown,
  timePerTask: recalculatedTimePerTask,
}
```

**Current day's `tasks` array is only touched if the user chose to carry an incomplete task to today** (Step A "No → add to today's queue"). In that case, append the task to `tasks` and call `save()`.

### `markDayResolved(date, type)`

Quick-write for "Day Off" and "Workday (not tracked)" — used from both the initial prompt and the pre-step.

```javascript
// type: 'dayOff' | 'dayNotTracked'
await db.collection('users').doc(uid).collection('history').doc(date).set({
  date,
  [type]: true,
  savedAt: Timestamp.now()
}, { merge: true });
```

---

## New Firestore History Fields

| Field | Type | Description |
|---|---|---|
| `dayNotTracked` | boolean | User marked day as a workday they didn't track |
| `wrapUpCompleted` | boolean | Wrap-up wizard was fully completed |
| `wrapUpSavedAt` | Timestamp | When the wrap-up was committed |

`dayNotTracked` days display in the History view the same way "Day Off" days do — same style, different label.

---

## New Functions

| Function | Purpose |
|---|---|
| `checkPreviousDayWrapUp()` | Entry point — detects incomplete days, triggers prompt |
| `getIncompletePastDays()` | Returns array of past dates (as strings) needing resolution, sorted newest-first |
| `openWrapUpPrompt(dates)` | Shows Stage 1 modal |
| `openWrapUpWizard(date, historyDoc)` | Builds and shows the two-panel wizard |
| `buildWizardSteps(historyDoc)` | Generates ordered step list from history data |
| `renderWrapUpTimeline(tasks, date)` | Left panel calendar — wraps existing render logic, read-only |
| `commitWrapUp(date, amendments)` | Saves all changes to Firestore, optionally updates today's queue |
| `markDayResolved(date, type)` | Handles quick Day Off / Workday (not tracked) writes |

---

## New HTML Elements

- `#wrapUpPromptOverlay` — Stage 1 prompt, small centered modal
- `#wrapUpOverlay` — Stage 2 wizard, two-panel wider modal
- `#wrapUpTimeline` — left panel, inside `#wrapUpOverlay`
- `#wrapUpWizardPanel` — right panel, inside `#wrapUpOverlay`

---

## Design Decisions & Philosophy

- **No gap detection.** We are not analyzing whether there are unrecorded gaps in the day. We assume that if the user ended the day, the day is correct — gaps included. Wrap-up only handles days where "End Day" was never hit.
- **No tracking overwhelm.** Every step should feel like a helpful nudge. Keep questions minimal and direct. Don't surface information the user doesn't need to act on.
- **History-only writes.** Wrap-up amends past history only. It does not alter the current day's state except to carry forward tasks the user explicitly requests.
- **Stress score is auto-calculated.** Not user input. Recalculate from updated task data on commit.
- **"Workday (not tracked)"** is a new state alongside `dayEnded` and `dayOff`. Displays identically to Day Off in the History view, with a different label.
