// dev-only demo data. pure and deterministic, same now in, same bytes out. the signals are shaped so every
// gated insight clears its threshold, and all of it must pass parseBackup (demoSeed.test.ts round-trips it)
import type {
  BreakdownSource,
  DayOfWeek,
  FocusSession,
  ScheduleStatus,
  SchedulingSignal,
  SessionEndReason,
  SignalOutcome,
  Subtask,
  Task,
  TaskStatus,
} from '@/types';

export interface DemoData {
  tasks: Task[];
  sessions: FocusSession[];
  signals: SchedulingSignal[];
}

const CREATED_HOUR = 17;
// same hour for every past completion, so the streak depends only on the day offsets
const COMPLETED_HOUR = 20;
// early enough to be in the past for anyone seeding after breakfast
const COMPLETED_TODAY_HOUR = 8;
// the break length in DEFAULT_SETTINGS
const BREAK_SECONDS = 300;

function at(now: Date, dayOffset: number, hour: number): string {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    0,
    0,
    0,
  ).toISOString();
}

// keeps recordedAt agreeing with the signal's own dayOfWeek and hourOfDay, a mismatch looks broken on screen
function onWeekday(now: Date, day: DayOfWeek, weeksBack: number, hour: number): string {
  const daysBack = ((now.getDay() - day + 7) % 7) + weeksBack * 7;
  return at(now, -daysBack, hour);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface TaskRow {
  title: string;
  subject: string | null;
  description: string | null;
  // days from now, negative is past
  due: number;
  dueHour: number;
  // always negative
  created: number;
  status: TaskStatus;
  // null unless status is complete
  done: number | null;
  scheduleStatus: ScheduleStatus;
  // read as proposedTime when scheduleStatus is proposed, startTime otherwise. null leaves both null
  slot: number | null;
  slotHour: number;
  breakdownSource: BreakdownSource;
  // starts with an IMPERATIVE_VERBS verb and has no VAGUE_PHRASES entry, like accepted model output
  starterAction: string;
  // [title, estimatedMinutes], in order
  steps: readonly (readonly [string, number])[];
}

// completions run five consecutive days and then gap, so the streak reads a believable five, not
// twenty-one. three unstarted tasks are past due so the overdue tab has something in it
const TASK_ROWS: readonly TaskRow[] = [
  {
    title: 'Read Gatsby chapters 4 to 6',
    subject: 'English',
    description: 'Annotate anything about money.',
    due: -20, dueHour: 22, created: -22, status: 'complete', done: -20,
    scheduleStatus: 'confirmed', slot: -21, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Open the book to page 61 and read the first two pages',
    steps: [
      ['Read chapter 4 with a pencil in hand', 25],
      ['Mark three quotes about money', 15],
      ['Write two sentences under each quote', 20],
    ],
  },
  {
    title: 'Cell transport worksheet',
    subject: 'Biology',
    description: null,
    due: -18, dueHour: 15, created: -21, status: 'complete', done: -18,
    scheduleStatus: 'confirmed', slot: -19, slotHour: 15, breakdownSource: 'template',
    starterAction: 'Copy the three transport terms onto a sticky note',
    steps: [
      ['Copy the three transport terms into your notes', 10],
      ['Label the diagram on page 2', 20],
      ['Answer questions 1 to 6', 25],
    ],
  },
  {
    title: 'Quadratic formula problem set',
    subject: 'Algebra 2',
    description: null,
    due: -17, dueHour: 8, created: -20, status: 'complete', done: -17,
    scheduleStatus: 'confirmed', slot: -18, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Write the quadratic formula at the top of a blank page',
    steps: [
      ['Copy the formula onto a note card', 10],
      ['Solve problems 1 to 5', 30],
      ['Check the answers against the key', 15],
    ],
  },
  {
    title: 'Chapter 12 outline on Reconstruction',
    subject: 'US History',
    description: null,
    due: -16, dueHour: 22, created: -19, status: 'complete', done: -16,
    scheduleStatus: 'pinned', slot: -17, slotHour: 19, breakdownSource: 'model',
    starterAction: 'Open your notes and list the three Reconstruction amendments',
    steps: [
      ['List the three Reconstruction amendments', 15],
      ['Write one line per section heading', 25],
      ['Type the outline into the doc', 20],
    ],
  },
  {
    title: 'Vocabulary list unidad 3',
    subject: 'Spanish',
    description: null,
    due: -14, dueHour: 8, created: -18, status: 'complete', done: -15,
    scheduleStatus: 'confirmed', slot: -16, slotHour: 15, breakdownSource: 'template',
    starterAction: 'Write the first ten vocab words in the left column',
    steps: [
      ['Write the first ten words in the left column', 20],
      ['Say each word out loud twice', 15],
      ['Quiz yourself with the list covered', 15],
    ],
  },
  {
    title: 'Balancing equations worksheet',
    subject: 'Chemistry',
    description: null,
    due: -14, dueHour: 15, created: -17, status: 'complete', done: -14,
    scheduleStatus: 'confirmed', slot: -15, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Copy equation one onto scratch paper and count the atoms',
    steps: [
      ['Copy equation one and count the atoms', 15],
      ['Balance equations 1 to 4', 30],
      ['Check the totals on both sides', 10],
    ],
  },
  {
    title: 'Symbolism paragraph on the green light',
    subject: 'English',
    description: 'One paragraph, no more than 200 words.',
    due: -13, dueHour: 22, created: -16, status: 'complete', done: -13,
    scheduleStatus: 'confirmed', slot: -14, slotHour: 17, breakdownSource: 'model',
    starterAction: 'Highlight two green-light sentences in chapter 5',
    steps: [
      ['Highlight two green-light sentences', 10],
      ['Draft the paragraph in one sitting', 30],
      ['Read it aloud and fix two lines', 15],
    ],
  },
  {
    title: 'Photosynthesis lab write-up',
    subject: 'Biology',
    description: null,
    due: -10, dueHour: 15, created: -14, status: 'complete', done: -11,
    scheduleStatus: 'pinned', slot: -12, slotHour: 16, breakdownSource: 'user',
    starterAction: 'Open the lab handout and copy the data table headings',
    steps: [
      ['Copy the data table headings', 15],
      ['Graph the results on the grid', 25],
      ['Write the conclusion paragraph', 30],
    ],
  },
  {
    title: 'Systems of equations practice',
    subject: 'Algebra 2',
    description: null,
    due: -10, dueHour: 8, created: -13, status: 'complete', done: -10,
    scheduleStatus: 'confirmed', slot: -11, slotHour: 15, breakdownSource: 'model',
    starterAction: 'Write the two equations from problem 1 on a fresh page',
    steps: [
      ['Write both equations on a fresh page', 10],
      ['Solve problems 1 to 8', 35],
      ['Check two answers by substitution', 15],
    ],
  },
  {
    title: 'Primary source analysis packet',
    subject: 'US History',
    description: null,
    due: -9, dueHour: 22, created: -12, status: 'complete', done: -9,
    scheduleStatus: 'confirmed', slot: -10, slotHour: 19, breakdownSource: 'model',
    starterAction: 'Read the first paragraph of the source out loud',
    steps: [
      ['Read the source out loud once', 20],
      ['Underline four phrases you can quote', 15],
      ['Answer the three questions below it', 25],
    ],
  },
  {
    title: 'Preterite and imperfect exercises',
    subject: 'Spanish',
    description: null,
    due: -8, dueHour: 8, created: -11, status: 'complete', done: -8,
    scheduleStatus: 'confirmed', slot: -9, slotHour: 15, breakdownSource: 'template',
    starterAction: 'Underline every past-tense verb in the first exercise',
    steps: [
      ['Underline every past-tense verb in exercise 1', 15],
      ['Complete exercises 1 to 3', 30],
      ['Correct exercise 1 against the key', 10],
    ],
  },
  {
    title: 'Mole conversions problem set',
    subject: 'Chemistry',
    description: null,
    due: -7, dueHour: 15, created: -10, status: 'complete', done: -7,
    scheduleStatus: 'confirmed', slot: -8, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Write the molar mass of carbon at the top of the page',
    steps: [
      ['Write the molar mass of carbon at the top', 10],
      ['Solve problems 1 to 6', 35],
      ['Circle the two you want to ask about', 10],
    ],
  },
  {
    title: 'Gatsby essay outline',
    subject: 'English',
    description: null,
    due: -6, dueHour: 22, created: -9, status: 'complete', done: -6,
    scheduleStatus: 'pinned', slot: -7, slotHour: 20, breakdownSource: 'model',
    starterAction: 'Type the essay title and three bullet headings',
    steps: [
      ['Type the essay title and three headings', 15],
      ['List two quotes under each heading', 25],
      ['Write one sentence of argument per heading', 20],
    ],
  },
  {
    title: 'Punnett square homework',
    subject: 'Biology',
    description: null,
    due: -4, dueHour: 15, created: -8, status: 'complete', done: -4,
    scheduleStatus: 'confirmed', slot: -5, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Draw one empty Punnett square grid on graph paper',
    steps: [
      ['Draw one empty Punnett grid on graph paper', 10],
      ['Fill in the first cross', 20],
      ['Complete problems 2 to 5', 30],
    ],
  },
  {
    title: 'Factoring polynomials worksheet',
    subject: 'Algebra 2',
    description: null,
    due: -3, dueHour: 8, created: -6, status: 'complete', done: -3,
    scheduleStatus: 'confirmed', slot: -4, slotHour: 17, breakdownSource: 'template',
    starterAction: 'Copy problem 1 onto a blank page and circle the common factor',
    steps: [
      ['Copy problem 1 and circle the common factor', 10],
      ['Factor problems 1 to 6', 30],
      ['Check three answers by expanding', 15],
    ],
  },
  {
    title: 'Gilded Age timeline',
    subject: 'US History',
    description: null,
    due: -2, dueHour: 22, created: -5, status: 'complete', done: -2,
    scheduleStatus: 'confirmed', slot: -3, slotHour: 19, breakdownSource: 'model',
    starterAction: 'Draw a horizontal line and mark 1870 and 1900 on it',
    steps: [
      ['Draw a line and mark 1870 and 1900', 10],
      ['Add six events with their dates', 25],
      ['Write one line on why each matters', 20],
    ],
  },
  {
    title: 'Dialogue script for Spanish class',
    subject: 'Spanish',
    description: null,
    due: -1, dueHour: 8, created: -4, status: 'complete', done: -1,
    scheduleStatus: 'pinned', slot: -2, slotHour: 16, breakdownSource: 'user',
    starterAction: 'Open a blank doc and type the two character names',
    steps: [
      ['Type the two character names', 10],
      ['Write eight lines of dialogue', 30],
      ['Read the script aloud once', 15],
    ],
  },
  {
    title: 'Stoichiometry practice set',
    subject: 'Chemistry',
    description: null,
    due: 0, dueHour: 23, created: -3, status: 'complete', done: 0,
    scheduleStatus: 'confirmed', slot: -1, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Copy the first balanced equation into your notebook',
    steps: [
      ['Copy the first balanced equation', 10],
      ['Solve problems 1 to 5', 30],
      ['Check the units on each answer', 15],
    ],
  },
  {
    title: 'Lab report on enzyme activity',
    subject: 'Biology',
    description: 'Method, results, conclusion. Graph goes in results.',
    due: 1, dueHour: 15, created: -3, status: 'in_progress', done: null,
    scheduleStatus: 'pinned', slot: 0, slotHour: 19, breakdownSource: 'model',
    starterAction: 'Open the lab notebook and copy the enzyme data table',
    steps: [
      ['Copy the enzyme data table into the notebook', 15],
      ['Graph the rate against temperature', 25],
      ['Write the method section', 30],
      ['Write the conclusion', 20],
    ],
  },
  {
    title: 'Essay draft on the American Dream',
    subject: 'English',
    description: 'Four paragraphs minimum. Two quotes per body paragraph.',
    due: 2, dueHour: 22, created: -4, status: 'in_progress', done: null,
    scheduleStatus: 'confirmed', slot: 1, slotHour: 17, breakdownSource: 'model',
    starterAction: "Type one sentence naming the essay's main claim",
    steps: [
      ['Type one sentence naming the main claim', 15],
      ['List three quotes with page numbers', 25],
      ['Draft the opening paragraph', 30],
      ['Read the draft aloud once', 15],
    ],
  },
  {
    title: 'Listening comprehension packet',
    subject: 'Spanish',
    description: null,
    due: -5, dueHour: 8, created: -7, status: 'not_started', done: null,
    scheduleStatus: 'unplaced', slot: null, slotHour: 0, breakdownSource: 'template',
    starterAction: 'Play track 1 and write down the first three words you hear',
    steps: [
      ['Play track 1 and write the first three words', 10],
      ['Answer questions 1 to 5', 25],
      ['Replay track 1 and check two answers', 15],
    ],
  },
  {
    title: 'Quiz corrections for unit 4',
    subject: 'Chemistry',
    description: null,
    due: -2, dueHour: 15, created: -4, status: 'not_started', done: null,
    scheduleStatus: 'unscheduled', slot: null, slotHour: 0, breakdownSource: 'user',
    starterAction: 'Copy question 1 and its correct answer into your notebook',
    steps: [
      ['Copy question 1 and its correct answer', 10],
      ['Rewrite the four answers you missed', 25],
      ['Write one line on why each was wrong', 15],
    ],
  },
  {
    title: 'Reading response for chapter 8',
    subject: null,
    description: null,
    due: -1, dueHour: 22, created: -3, status: 'not_started', done: null,
    scheduleStatus: 'unscheduled', slot: null, slotHour: 0, breakdownSource: 'model',
    starterAction: 'Read the first page of chapter 8 with a pencil in hand',
    steps: [
      ['Read the first page with a pencil in hand', 20],
      ['Mark two passages to quote', 15],
      ['Write the response in one paragraph', 25],
    ],
  },
  {
    title: 'Unit test corrections',
    subject: 'Algebra 2',
    description: null,
    due: 3, dueHour: 8, created: -2, status: 'not_started', done: null,
    scheduleStatus: 'auto', slot: 2, slotHour: 16, breakdownSource: 'model',
    starterAction: 'Copy the three problems you missed onto a clean sheet',
    steps: [
      ['Copy the three problems you missed', 10],
      ['Solve each one again on a clean sheet', 30],
      ['Check the answers against the key', 15],
    ],
  },
  {
    title: 'DBQ practice essay',
    subject: 'US History',
    description: null,
    due: 4, dueHour: 22, created: -2, status: 'not_started', done: null,
    scheduleStatus: 'proposed', slot: 3, slotHour: 17, breakdownSource: 'model',
    starterAction: 'Print the DBQ documents and number them 1 through 7',
    steps: [
      ['Print the documents and number them', 10],
      ['Read documents 1 to 3 and underline claims', 30],
      ['Write a one-sentence thesis', 20],
      ['Outline three body paragraphs', 25],
    ],
  },
  {
    title: 'Chapter 9 reading notes',
    subject: 'Biology',
    description: null,
    due: 5, dueHour: 15, created: -1, status: 'not_started', done: null,
    scheduleStatus: 'auto', slot: 4, slotHour: 16, breakdownSource: 'template',
    starterAction: 'Open the textbook to page 214 and read the first heading',
    steps: [
      ['Open the textbook to page 214', 10],
      ['Read the first section and take notes', 30],
      ['List the six key terms with meanings', 20],
    ],
  },
  {
    title: 'Oral presentation script',
    subject: 'Spanish',
    description: null,
    due: 6, dueHour: 8, created: -1, status: 'not_started', done: null,
    scheduleStatus: 'proposed', slot: 5, slotHour: 19, breakdownSource: 'model',
    starterAction: 'Write the opening line of your presentation on an index card',
    steps: [
      ['Write the opening line on an index card', 10],
      ['Draft the middle three points', 30],
      ['Rehearse the script once out loud', 15],
    ],
  },
  {
    title: 'Lab safety quiz prep',
    subject: 'Chemistry',
    description: null,
    due: 7, dueHour: 15, created: -1, status: 'not_started', done: null,
    scheduleStatus: 'unscheduled', slot: null, slotHour: 0, breakdownSource: 'user',
    starterAction: 'Open the safety handout and highlight the first rule',
    steps: [
      ['Open the safety handout and highlight rule 1', 10],
      ['Copy the ten rules into your notes', 25],
      ['Quiz yourself with the handout closed', 15],
    ],
  },
];

// two steps shown as simplified once (taskIndex:stepIndex), so import is exercised on originalTitle
const SIMPLIFIED_STEPS: ReadonlyMap<string, string> = new Map([
  ['6:1', 'Draft the whole symbolism paragraph in one go'],
  ['19:2', 'Draft the opening and the second paragraph'],
]);

function buildTask(now: Date, row: TaskRow, index: number): Task {
  const taskId = `demo-task-${pad2(index + 1)}`;
  const createdAt = at(now, row.created, CREATED_HOUR);
  const completedAt =
    row.done === null
      ? null
      : at(now, row.done, row.done === 0 ? COMPLETED_TODAY_HOUR : COMPLETED_HOUR);

  const subtasks: Subtask[] = row.steps.map(([title, estimatedMinutes], order) => {
    const original = SIMPLIFIED_STEPS.get(`${index}:${order}`);
    // in_progress means exactly the first step is done
    const isComplete =
      row.status === 'complete' || (row.status === 'in_progress' && order === 0);
    return {
      id: `demo-sub-${pad2(index + 1)}-${order + 1}`,
      parentTaskId: taskId,
      title,
      estimatedMinutes,
      isComplete,
      order,
      completedAt: isComplete ? (completedAt ?? at(now, row.created + 1, CREATED_HOUR)) : null,
      ...(original === undefined ? {} : { originalTitle: original }),
    };
  });

  const slotIso = row.slot === null ? null : at(now, row.slot, row.slotHour);
  const isProposal = row.scheduleStatus === 'proposed';

  return {
    id: taskId,
    title: row.title,
    subject: row.subject,
    description: row.description,
    dueDate: at(now, row.due, row.dueHour),
    startTime: isProposal ? null : slotIso,
    proposedTime: isProposal ? slotIso : null,
    // omitted unless there's a live proposal, the shape an older task reads back as
    ...(isProposal ? { proposedAt: at(now, -1, 7) } : {}),
    durationMinutes: row.steps.reduce((total, [, minutes]) => total + minutes, 0),
    status: row.status,
    scheduleStatus: row.scheduleStatus,
    subtasks,
    starterAction: row.starterAction,
    breakdownSource: row.breakdownSource,
    createdAt,
    updatedAt: completedAt ?? (row.status === 'in_progress' ? at(now, -1, 19) : createdAt),
    completedAt,
  };
}

interface SessionRow {
  // index into TASK_ROWS
  task: number;
  // never earlier than task creation
  ago: number;
  hour: number;
  // null is a session the app was killed in the middle of
  minutes: number | null;
  endReason: SessionEndReason | null;
  breaks: number;
}

const SESSION_ROWS: readonly SessionRow[] = [
  { task: 0, ago: 21, hour: 16, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 0, ago: 20, hour: 17, minutes: 30, endReason: 'completed', breaks: 0 },
  { task: 1, ago: 19, hour: 15, minutes: 50, endReason: 'completed', breaks: 1 },
  { task: 2, ago: 18, hour: 16, minutes: 40, endReason: 'completed', breaks: 1 },
  { task: 2, ago: 17, hour: 9, minutes: 25, endReason: 'interrupted', breaks: 0 },
  { task: 3, ago: 17, hour: 19, minutes: 55, endReason: 'completed', breaks: 1 },
  { task: 4, ago: 16, hour: 15, minutes: 35, endReason: 'completed', breaks: 0 },
  { task: 5, ago: 15, hour: 16, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 5, ago: 14, hour: 20, minutes: 20, endReason: 'abandoned', breaks: 0 },
  { task: 6, ago: 14, hour: 17, minutes: 50, endReason: 'completed', breaks: 1 },
  { task: 6, ago: 13, hour: 16, minutes: 30, endReason: 'completed', breaks: 0 },
  { task: 7, ago: 12, hour: 16, minutes: 60, endReason: 'completed', breaks: 2 },
  { task: 7, ago: 11, hour: 15, minutes: 35, endReason: 'completed', breaks: 1 },
  { task: 8, ago: 11, hour: 20, minutes: 40, endReason: 'completed', breaks: 1 },
  { task: 8, ago: 10, hour: 15, minutes: 25, endReason: 'interrupted', breaks: 0 },
  { task: 9, ago: 10, hour: 19, minutes: 55, endReason: 'completed', breaks: 1 },
  { task: 10, ago: 9, hour: 15, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 10, ago: 8, hour: 16, minutes: 20, endReason: 'abandoned', breaks: 0 },
  { task: 11, ago: 8, hour: 20, minutes: 50, endReason: 'completed', breaks: 1 },
  { task: 12, ago: 7, hour: 20, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 12, ago: 6, hour: 17, minutes: 40, endReason: 'completed', breaks: 1 },
  { task: 13, ago: 5, hour: 16, minutes: 55, endReason: 'completed', breaks: 2 },
  { task: 13, ago: 4, hour: 15, minutes: 30, endReason: 'completed', breaks: 0 },
  { task: 14, ago: 4, hour: 17, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 15, ago: 3, hour: 19, minutes: 50, endReason: 'completed', breaks: 1 },
  { task: 16, ago: 2, hour: 16, minutes: 40, endReason: 'completed', breaks: 1 },
  { task: 17, ago: 1, hour: 16, minutes: 45, endReason: 'completed', breaks: 1 },
  { task: 17, ago: 1, hour: 20, minutes: 15, endReason: 'interrupted', breaks: 0 },
  { task: 18, ago: 3, hour: 19, minutes: 35, endReason: 'completed', breaks: 1 },
  { task: 18, ago: 2, hour: 21, minutes: null, endReason: null, breaks: 0 },
  { task: 18, ago: 1, hour: 21, minutes: null, endReason: null, breaks: 0 },
  { task: 19, ago: 3, hour: 17, minutes: 40, endReason: 'completed', breaks: 1 },
  { task: 19, ago: 2, hour: 20, minutes: 20, endReason: 'abandoned', breaks: 0 },
  { task: 19, ago: 0, hour: 7, minutes: null, endReason: null, breaks: 0 },
];

function buildSession(now: Date, row: SessionRow, index: number, tasks: readonly Task[]): FocusSession {
  const task = tasks[row.task];
  // derived, not tabulated, so it's always a subtask the task actually has
  const subtask = task.subtasks[row.ago % task.subtasks.length];
  const startedAt = at(now, -row.ago, row.hour);

  return {
    id: `demo-session-${pad2(index + 1)}`,
    taskId: task.id,
    taskTitleSnapshot: task.title,
    subtaskId: subtask.id,
    startedAt,
    endedAt: row.minutes === null ? null : at(now, -row.ago, row.hour + 1),
    durationSeconds: row.minutes === null ? null : row.minutes * 60,
    breaksTaken: row.breaks,
    breakSecondsTotal: row.breaks * BREAK_SECONDS,
    completedSubtaskIds: row.endReason === 'completed' ? [subtask.id] : [],
    endReason: row.endReason,
  };
}

interface SignalRow {
  day: DayOfWeek;
  hour: number;
  outcome: SignalOutcome;
  // null when the block was never timed
  actual: number | null;
  estimated: number | null;
  weeksBack: number;
  // null is a signal whose task was deleted
  task: number | null;
}

// tuesday 16:00 wins at 0.8 (1.0 would look fake) with every other bucket at 0.75 or below, and the
// thirteen timed ratios spread from 0.8 to 2.5 around a median of exactly 1.5, so calibration and the
// scheduler both visibly act on the history
const SIGNAL_ROWS: readonly SignalRow[] = [
  // tuesday 16:00, the productive window: 4 of 5
  { day: 2, hour: 16, outcome: 'completed', actual: 45, estimated: 30, weeksBack: 0, task: 0 },
  { day: 2, hour: 16, outcome: 'completed', actual: 42, estimated: 30, weeksBack: 1, task: 3 },
  { day: 2, hour: 16, outcome: 'completed', actual: 24, estimated: 30, weeksBack: 2, task: 6 },
  { day: 2, hour: 16, outcome: 'completed', actual: null, estimated: 30, weeksBack: 1, task: 9 },
  { day: 2, hour: 16, outcome: 'partial', actual: 30, estimated: 25, weeksBack: 2, task: 12 },

  // monday 15:00, 3 of 4, the closest runner-up at 0.75
  { day: 1, hour: 15, outcome: 'completed', actual: 30, estimated: 35, weeksBack: 0, task: 1 },
  { day: 1, hour: 15, outcome: 'completed', actual: 33, estimated: 30, weeksBack: 1, task: 4 },
  { day: 1, hour: 15, outcome: 'completed', actual: null, estimated: null, weeksBack: 2, task: 7 },
  { day: 1, hour: 15, outcome: 'skipped', actual: null, estimated: 30, weeksBack: 1, task: 10 },

  // thursday 16:00, 3 of 5
  { day: 4, hour: 16, outcome: 'completed', actual: 45, estimated: 45, weeksBack: 0, task: 2 },
  { day: 4, hour: 16, outcome: 'completed', actual: 55, estimated: 30, weeksBack: 1, task: 5 },
  { day: 4, hour: 16, outcome: 'completed', actual: null, estimated: null, weeksBack: 2, task: 8 },
  { day: 4, hour: 16, outcome: 'partial', actual: 60, estimated: 30, weeksBack: 0, task: 11 },
  { day: 4, hour: 16, outcome: 'skipped', actual: null, estimated: null, weeksBack: 2, task: 14 },

  // wednesday 17:00, 2 of 4. straight after school, and it shows
  { day: 3, hour: 17, outcome: 'completed', actual: 40, estimated: 25, weeksBack: 0, task: 13 },
  { day: 3, hour: 17, outcome: 'completed', actual: 50, estimated: 20, weeksBack: 2, task: 15 },
  { day: 3, hour: 17, outcome: 'partial', actual: null, estimated: 45, weeksBack: 1, task: 16 },
  { day: 3, hour: 17, outcome: 'skipped', actual: null, estimated: null, weeksBack: 1, task: 17 },

  // tuesday 19:00, 2 of 4. late blocks run long
  { day: 2, hour: 19, outcome: 'completed', actual: 70, estimated: 30, weeksBack: 0, task: 18 },
  { day: 2, hour: 19, outcome: 'completed', actual: null, estimated: null, weeksBack: 1, task: 19 },
  { day: 2, hour: 19, outcome: 'partial', actual: 90, estimated: 45, weeksBack: 2, task: 20 },
  { day: 2, hour: 19, outcome: 'partial', actual: null, estimated: 30, weeksBack: 1, task: 21 },

  // saturday 11:00, 2 of 3
  { day: 6, hour: 11, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 22 },
  { day: 6, hour: 11, outcome: 'completed', actual: null, estimated: null, weeksBack: 1, task: 23 },
  { day: 6, hour: 11, outcome: 'partial', actual: null, estimated: 40, weeksBack: 2, task: 24 },

  // sunday 14:00, 1 of 3
  { day: 0, hour: 14, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 25 },
  { day: 0, hour: 14, outcome: 'partial', actual: null, estimated: null, weeksBack: 1, task: 26 },
  { day: 0, hour: 14, outcome: 'skipped', actual: null, estimated: null, weeksBack: 2, task: 27 },

  // friday 16:00, 1 of 3
  { day: 5, hour: 16, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 0 },
  { day: 5, hour: 16, outcome: 'skipped', actual: null, estimated: null, weeksBack: 1, task: 3 },
  { day: 5, hour: 16, outcome: 'skipped', actual: null, estimated: 25, weeksBack: 2, task: 6 },

  // monday 20:00, 1 of 3
  { day: 1, hour: 20, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 9 },
  { day: 1, hour: 20, outcome: 'partial', actual: null, estimated: null, weeksBack: 1, task: 12 },
  { day: 1, hour: 20, outcome: 'skipped', actual: null, estimated: null, weeksBack: 2, task: 1 },

  // thursday 20:00, 2 of 3
  { day: 4, hour: 20, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 4 },
  { day: 4, hour: 20, outcome: 'completed', actual: null, estimated: null, weeksBack: 1, task: 7 },
  { day: 4, hour: 20, outcome: 'skipped', actual: null, estimated: null, weeksBack: 2, task: 10 },

  // wednesday 15:00, 2 of 3
  { day: 3, hour: 15, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 2 },
  { day: 3, hour: 15, outcome: 'completed', actual: null, estimated: null, weeksBack: 1, task: 5 },
  { day: 3, hour: 15, outcome: 'partial', actual: null, estimated: null, weeksBack: 2, task: 8 },

  // under the three-signal bar, so productiveWindow ignores them
  { day: 2, hour: 9, outcome: 'completed', actual: null, estimated: null, weeksBack: 0, task: 11 },
  { day: 5, hour: 21, outcome: 'completed', actual: null, estimated: null, weeksBack: 1, task: 13 },
  { day: 5, hour: 21, outcome: 'partial', actual: null, estimated: null, weeksBack: 2, task: 14 },
  { day: 6, hour: 15, outcome: 'skipped', actual: null, estimated: null, weeksBack: 0, task: null },
  { day: 0, hour: 20, outcome: 'completed', actual: null, estimated: null, weeksBack: 2, task: 16 },
];

function buildSignal(now: Date, row: SignalRow, index: number, tasks: readonly Task[]): SchedulingSignal {
  return {
    id: `demo-signal-${pad2(index + 1)}`,
    taskId: row.task === null ? null : tasks[row.task].id,
    dayOfWeek: row.day,
    hourOfDay: row.hour,
    outcome: row.outcome,
    actualDurationMinutes: row.actual,
    estimatedDurationMinutes: row.estimated,
    recordedAt: onWeekday(now, row.day, row.weeksBack, row.hour),
  };
}

/** three weeks of plausible history ending at now */
export function generateDemoData(now: Date): DemoData {
  const tasks = TASK_ROWS.map((row, index) => buildTask(now, row, index));
  return {
    tasks,
    sessions: SESSION_ROWS.map((row, index) => buildSession(now, row, index, tasks)),
    signals: SIGNAL_ROWS.map((row, index) => buildSignal(now, row, index, tasks)),
  };
}
