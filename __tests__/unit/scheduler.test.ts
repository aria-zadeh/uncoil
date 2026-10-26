import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import {
  AUTO_ACCEPT_DELAY_MS,
  BUFFER_MINUTES,
  CONTINUOUS_WORK_LIMIT_MINUTES,
  DAY_CAPACITY_DISCARD_MULTIPLIER,
  REPLACEMENT_IMPROVEMENT_THRESHOLD,
  SLOT_MINUTES,
  WEIGHTS,
  buildCapacityContext,
  buildHistory,
  canReplaceBlock,
  forecastFeasibility,
  proposeSlot,
  scoreSlot,
  shouldAutoAcceptProposal,
  type SchedulerInput,
} from '@/services/scheduler';
import { blockLengthMultiplier } from '@/services/insights';
import type { FocusSession, SchedulingSignal, Task, UserSettings } from '@/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a monday at 09:00 local, so weekday rules are legible
const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    energyPeakStart: 15,
    energyPeakEnd: 17,
    typicalSessionMinutes: 30,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'target',
    title: 'Chapter 4 notes',
    subject: 'Biology',
    description: null,
    dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    startTime: null,
    proposedTime: null,
    durationMinutes: 60,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    proposedAt: null,
    ...overrides,
  };
}

function signal(overrides: Partial<SchedulingSignal> = {}): SchedulingSignal {
  return {
    id: `sig-${Math.round(Math.random() * 1e9)}`,
    taskId: 'other',
    dayOfWeek: 1,
    hourOfDay: 15,
    outcome: 'completed',
    actualDurationMinutes: 60,
    estimatedDurationMinutes: 60,
    recordedAt: new Date(NOW.getTime() - DAY).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: `session-${Math.round(Math.random() * 1e9)}`,
    taskId: 'other',
    taskTitleSnapshot: 'Chapter 4 notes',
    subtaskId: null,
    startedAt: new Date(NOW.getTime() - DAY).toISOString(),
    endedAt: new Date(NOW.getTime() - DAY + 30 * MINUTE).toISOString(),
    durationSeconds: 30 * 60,
    breaksTaken: 0,
    breakSecondsTotal: 0,
    completedSubtaskIds: [],
    endReason: 'completed',
    ...overrides,
  };
}

function input(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    task: task(),
    otherTasks: [],
    settings: settings(),
    signals: [],
    now: NOW,
    ...overrides,
  };
}

function localHour(iso: string): number {
  return new Date(iso).getHours();
}

describe('proposeSlot, basic behaviour', () => {
  it('returns a proposal for an ordinary task', () => {
    const p = proposeSlot(input());
    expect(p).not.toBeNull();
    expect(new Date(p!.startIso).getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it('returns null when the due date has already passed', () => {
    const p = proposeSlot(
      input({ task: task({ dueDate: new Date(NOW.getTime() - DAY).toISOString() }) }),
    );
    expect(p).toBeNull();
  });

  it('returns null when the task cannot fit before the due date', () => {
    const p = proposeSlot(
      input({
        task: task({
          dueDate: new Date(NOW.getTime() + 30 * MINUTE).toISOString(),
          durationMinutes: 120,
        }),
      }),
    );
    expect(p).toBeNull();
  });

  it('aligns proposals to the 15-minute grid', () => {
    const p = proposeSlot(input({ now: new Date(2026, 8, 7, 9, 7, 0, 0) }));
    expect(p).not.toBeNull();
    const start = new Date(p!.startIso);
    expect(start.getMinutes() % SLOT_MINUTES).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });

  it('reserves the duration, so end minus start is the task length', () => {
    const p = proposeSlot(input({ task: task({ durationMinutes: 45 }) }));
    expect(new Date(p!.endIso).getTime() - new Date(p!.startIso).getTime()).toBe(45 * MINUTE);
  });

  it('falls back to the typical session length when duration is unset', () => {
    const p = proposeSlot(
      input({
        task: task({ durationMinutes: null }),
        settings: settings({ typicalSessionMinutes: 25 }),
      }),
    );
    expect(new Date(p!.endIso).getTime() - new Date(p!.startIso).getTime()).toBe(25 * MINUTE);
  });
});

describe('proposeSlot, exclusion rules', () => {
  it('never proposes inside quiet hours', () => {
    for (let offset = 0; offset < 40; offset += 1) {
      const now = new Date(NOW.getTime() + offset * 3 * HOUR);
      const p = proposeSlot(
        input({ now, task: task({ dueDate: new Date(now.getTime() + 6 * DAY).toISOString() }) }),
      );
      if (p === null) continue;
      const startHour = localHour(p.startIso);
      const endHour = new Date(new Date(p.endIso).getTime() - 1).getHours();
      for (const h of [startHour, endHour]) {
        expect(h).toBeGreaterThanOrEqual(8);
        expect(h).toBeLessThan(23);
      }
    }
  });

  it('never proposes inside a declared busy block', () => {
    const s = settings({
      busyBlocks: [
        { day: 'mon', period: 'morning' },
        { day: 'mon', period: 'afternoon' },
        { day: 'mon', period: 'evening' },
      ],
    });
    const p = proposeSlot(input({ settings: s }));
    expect(p).not.toBeNull();
    expect(new Date(p!.startIso).getDay()).not.toBe(1);
  });

  it('rejects a slot that straddles a busy-period boundary', () => {
    // 11:00 + 90 minutes runs into a busy afternoon. checking only the start hour would accept it
    const s = settings({
      busyBlocks: [{ day: 'mon', period: 'afternoon' }],
      energyPeakStart: 11,
      energyPeakEnd: 12,
    });
    const p = proposeSlot(
      input({
        settings: s,
        task: task({ durationMinutes: 90, dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString() }),
      }),
    );
    expect(p).not.toBeNull();
    const start = new Date(p!.startIso);
    const end = new Date(p!.endIso);
    if (start.getDay() === 1) {
      expect(end.getHours() < 12 || start.getHours() >= 18).toBe(true);
    }
  });

  it('never overlaps a one-off calendar event', () => {
    const s = settings({
      calendarEvents: [
        {
          id: 'e1',
          title: 'Practice',
          date: '2026-09-07',
          startTime: '09:00',
          endTime: '20:00',
          repeatDays: [],
          createdAt: NOW.toISOString(),
        },
      ],
    });
    const p = proposeSlot(
      input({ settings: s, task: task({ dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString() }) }),
    );
    expect(p).not.toBeNull();
    const start = new Date(p!.startIso);
    if (start.getDate() === 7) {
      expect(start.getHours()).toBeGreaterThanOrEqual(20);
    }
  });

  // a repeating event has to block every occurrence, not just the first.
  // 2026-09-08 is the tuesday after NOW
  const PRACTICE: UserSettings['calendarEvents'][number] = {
    id: 'e1',
    title: 'Practice',
    date: '2026-09-08',
    startTime: '16:00',
    endTime: '17:30',
    repeatDays: ['tue', 'thu'],
    createdAt: NOW.toISOString(),
  };

  // now is 16:00 and the due date is the next midnight, so with nothing in the way 16:00 wins
  function proposeAfternoonOf(
    day: Date,
    calendarEvents: UserSettings['calendarEvents'],
  ): ReturnType<typeof proposeSlot> {
    const at16 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 16, 0, 0, 0);
    const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);
    return proposeSlot(
      input({
        settings: settings({ calendarEvents }),
        task: task({ durationMinutes: 60, dueDate: nextMidnight.toISOString() }),
        now: at16,
      }),
    );
  }

  function startOf(p: ReturnType<typeof proposeSlot>): Date {
    expect(p).not.toBeNull();
    return new Date(p!.startIso);
  }

  it('blocks a repeating event\'s occurrence two weeks after its date', () => {
    // two weeks after PRACTICE.date, so it only blocks if the expansion produced it
    const tuesday = new Date(2026, 8, 22);
    const blockEnd = new Date(2026, 8, 22, 17, 30, 0, 0).getTime();

    expect(startOf(proposeAfternoonOf(tuesday, [])).getHours()).toBe(16);
    expect(startOf(proposeAfternoonOf(tuesday, [PRACTICE])).getTime()).toBeGreaterThanOrEqual(
      blockEnd,
    );
  });

  it('does not block a weekday the repeating event does not list', () => {
    const wednesday = new Date(2026, 8, 23);
    expect(startOf(proposeAfternoonOf(wednesday, [PRACTICE])).getHours()).toBe(16);
  });

  it('never generates an occurrence before the event date', () => {
    const beforeItStarts = new Date(2026, 8, 8);
    const notYet = { ...PRACTICE, date: '2026-09-15' };
    expect(startOf(proposeAfternoonOf(beforeItStarts, [notYet])).getHours()).toBe(16);
  });

  it('leaves a one-off (repeatDays empty) blocking its own date and no other', () => {
    const oneOff = { ...PRACTICE, repeatDays: [] };
    const ownDate = new Date(2026, 8, 8);
    const twoWeeksLater = new Date(2026, 8, 22);

    expect(startOf(proposeAfternoonOf(ownDate, [oneOff])).getTime()).toBeGreaterThanOrEqual(
      new Date(2026, 8, 8, 17, 30, 0, 0).getTime(),
    );
    expect(startOf(proposeAfternoonOf(twoWeeksLater, [oneOff])).getHours()).toBe(16);
  });

  it('skips an event whose end is not after its start rather than blocking on it', () => {
    const zeroLength = { ...PRACTICE, endTime: '16:00' };
    const inverted = { ...PRACTICE, startTime: '17:30', endTime: '16:00' };
    const tuesday = new Date(2026, 8, 22);

    expect(startOf(proposeAfternoonOf(tuesday, [zeroLength])).getHours()).toBe(16);
    expect(startOf(proposeAfternoonOf(tuesday, [inverted])).getHours()).toBe(16);
  });

  it('never overlaps another scheduled task, including its buffer', () => {
    const occupiedStart = new Date(2026, 8, 7, 15, 0, 0, 0);
    const other = task({
      id: 'other',
      startTime: occupiedStart.toISOString(),
      durationMinutes: 60,
      scheduleStatus: 'confirmed',
    });
    const proposals: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = proposeSlot(
        input({
          otherTasks: [other],
          task: task({ id: `t${i}`, durationMinutes: 30 }),
          now: new Date(NOW.getTime() + i * 15 * MINUTE),
        }),
      );
      if (p) proposals.push(p.startIso);
    }
    const busyStart = occupiedStart.getTime();
    const busyEnd = busyStart + (60 + BUFFER_MINUTES) * MINUTE;
    for (const iso of proposals) {
      const s = new Date(iso).getTime();
      const e = s + 30 * MINUTE;
      expect(s < busyEnd && busyStart < e).toBe(false);
    }
  });

  it('ignores completed tasks when computing occupancy', () => {
    const done = task({
      id: 'done',
      status: 'complete',
      completedAt: NOW.toISOString(),
      startTime: new Date(2026, 8, 7, 15, 0, 0, 0).toISOString(),
      durationMinutes: 300,
    });
    const p = proposeSlot(input({ otherTasks: [done] }));
    expect(p).not.toBeNull();
  });
});

describe('proposeSlot, scoring', () => {
  it('prefers the declared energy window', () => {
    const p = proposeSlot(
      input({
        settings: settings({ energyPeakStart: 15, energyPeakEnd: 17 }),
        task: task({ durationMinutes: 60, dueDate: new Date(NOW.getTime() + 3 * DAY).toISOString() }),
      }),
    );
    expect(localHour(p!.startIso)).toBeGreaterThanOrEqual(15);
    expect(localHour(p!.startIso)).toBeLessThan(17);
  });

  it('avoids the last 24 hours before the due date when there is room earlier', () => {
    const due = new Date(NOW.getTime() + 3 * DAY);
    const p = proposeSlot(input({ task: task({ dueDate: due.toISOString() }) }));
    expect(new Date(p!.endIso).getTime()).toBeLessThan(due.getTime() - DAY);
  });

  it('breaks ties in favour of the earlier slot', () => {
    // no energy window and no history, so only the earlier-is-better term differs
    const s = settings({ energyPeakStart: 0, energyPeakEnd: 0 });
    const p = proposeSlot(
      input({ settings: s, task: task({ durationMinutes: 30 }), now: new Date(2026, 8, 7, 9, 0) }),
    );
    expect(p).not.toBeNull();
    expect(new Date(p!.startIso).getTime()).toBe(new Date(2026, 8, 7, 9, 0).getTime());
  });

  it(
    'avoids an hour with enough recorded skips (SCHEDULING.md 3a: replaces the old ' +
      'minimum-sample cliff with a shrinkage estimate -- see the "learned hour preference" ' +
      'describe block below for the graded, single-signal-does-not-swing-it behaviour)',
    () => {
      const s = settings({ energyPeakStart: 0, energyPeakEnd: 0 });
      // a completed baseline elsewhere, since in an all-skip world a 100% skip rate is just the average
      const baseline = Array.from({ length: 20 }, () =>
        signal({ dayOfWeek: 3, hourOfDay: 15, outcome: 'completed' }),
      );
      const many = Array.from({ length: 20 }, () =>
        signal({ dayOfWeek: 1, hourOfDay: 9, outcome: 'skipped' }),
      );
      const p = proposeSlot(
        input({ settings: s, signals: [...baseline, ...many], task: task({ durationMinutes: 30 }) }),
      );
      expect(p).not.toBeNull();
      expect(new Date(p!.startIso).getHours()).not.toBe(9);
    },
  );

  it('ignores signals older than the window', () => {
    const s = settings({ energyPeakStart: 0, energyPeakEnd: 0 });
    const stale = Array.from({ length: 10 }, () =>
      signal({
        dayOfWeek: 1,
        hourOfDay: 9,
        outcome: 'skipped',
        recordedAt: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      }),
    );
    const p = proposeSlot(input({ settings: s, signals: stale, task: task({ durationMinutes: 30 }) }));
    expect(new Date(p!.startIso).getHours()).toBe(9);
  });

  it('treats a partial outcome as neither positive nor negative', () => {
    const s = settings({ energyPeakStart: 0, energyPeakEnd: 0 });
    const partials = Array.from({ length: 6 }, () =>
      signal({ dayOfWeek: 1, hourOfDay: 9, outcome: 'partial' }),
    );
    const p = proposeSlot(input({ settings: s, signals: partials, task: task({ durationMinutes: 30 }) }));
    expect(new Date(p!.startIso).getHours()).toBe(9);
  });

  it('penalises a slot that would extend continuous work past the limit', () => {
    // a full-limit block ending at 14:00, then the candidate at 14:15
    const priorStart = new Date(2026, 8, 7, 12, 45, 0, 0);
    const prior = task({
      id: 'prior',
      startTime: priorStart.toISOString(),
      durationMinutes: CONTINUOUS_WORK_LIMIT_MINUTES,
      scheduleStatus: 'confirmed',
    });
    const s = settings({ energyPeakStart: 0, energyPeakEnd: 0 });
    const p = proposeSlot(
      input({
        settings: s,
        otherTasks: [prior],
        task: task({ durationMinutes: 60, dueDate: new Date(NOW.getTime() + 3 * DAY).toISOString() }),
        now: new Date(2026, 8, 7, 14, 0, 0, 0),
      }),
    );
    expect(p).not.toBeNull();
    const gapMinutes = (new Date(p!.startIso).getTime() - (priorStart.getTime() + CONTINUOUS_WORK_LIMIT_MINUTES * MINUTE)) / MINUTE;
    expect(gapMinutes).toBeGreaterThan(30);
  });
});

describe('scoreSlot, driven by real signals', () => {
  const slotStart = new Date(2026, 8, 7, 9, 0, 0, 0).getTime(); // monday 09:00, band 3
  const durationMs = 30 * MINUTE;

  function scoreAt(signals: SchedulingSignal[]): number {
    const baseInput = input({ signals, task: task({ durationMinutes: 30 }) });
    return scoreSlot(slotStart, durationMs, baseInput, buildHistory(signals, NOW), []);
  }

  // a completed baseline elsewhere gives this person an average a skip can fall short of
  function baseline(): SchedulingSignal[] {
    return Array.from({ length: 10 }, () => signal({ dayOfWeek: 3, hourOfDay: 15, outcome: 'completed' }));
  }

  it('a single skip nudges the score, not a full swing (SCHEDULING.md 3a replaces the old cliff)', () => {
    // recorded now, so the recency weight is 1.0 and only the sample weight is under test
    const fresh = (overrides: Partial<SchedulingSignal> = {}) =>
      signal({ recordedAt: NOW.toISOString(), ...overrides });

    const withZero = scoreAt(baseline());
    const withOne = scoreAt([...baseline(), fresh({ dayOfWeek: 1, hourOfDay: 9, outcome: 'skipped' })]);
    const withMany = scoreAt([
      ...baseline(),
      ...Array.from({ length: 10 }, () => fresh({ dayOfWeek: 1, hourOfDay: 9, outcome: 'skipped' })),
    ]);

    const oneSignalDelta = withZero - withOne;
    const manySignalDelta = withZero - withMany;

    expect(oneSignalDelta).toBeGreaterThan(0);
    expect(oneSignalDelta).toBeLessThan(WEIGHTS.history);
    expect(oneSignalDelta).toBeLessThan(manySignalDelta);
  });

  it("a bucket sitting exactly at this person's own average contributes nothing", () => {
    // the baseline puts this person's rate at 100%, so a 100% bucket sits exactly at the average
    const atAverage = [
      ...baseline(),
      ...Array.from({ length: 8 }, () => signal({ dayOfWeek: 1, hourOfDay: 9, outcome: 'completed' })),
    ];
    const history = buildHistory(atAverage, NOW);
    const bucket = history.get(1 * 24 + 9)!;
    expect(bucket.probability).toBeCloseTo(bucket.overallRate, 6);
    expect(scoreAt(atAverage)).toBeCloseTo(scoreAt(baseline()), 6);
  });

  it('a fortnight-old signal counts about half of a fresh one (a two-week half-life, not a hard cutoff)', () => {
    // the anchor keeps the bucket's effective sample size at or above one, so only the
    // recency weight differs between the two cases
    const anchor = Array.from({ length: 5 }, () => signal({ dayOfWeek: 1, hourOfDay: 9, outcome: 'skipped' }));
    const withAnchor = scoreAt([...baseline(), ...anchor]);
    const withFresh = scoreAt([
      ...baseline(),
      ...anchor,
      signal({ dayOfWeek: 1, hourOfDay: 9, outcome: 'completed', recordedAt: NOW.toISOString() }),
    ]);
    const withFortnightOld = scoreAt([
      ...baseline(),
      ...anchor,
      signal({
        dayOfWeek: 1,
        hourOfDay: 9,
        outcome: 'completed',
        recordedAt: new Date(NOW.getTime() - 14 * DAY).toISOString(),
      }),
    ]);

    const freshDelta = withFresh - withAnchor;
    const oldDelta = withFortnightOld - withAnchor;
    expect(freshDelta).toBeGreaterThan(0);
    expect(oldDelta).toBeGreaterThan(0);
    // not exactly half: the shrinkage constant keeps the ratio from being linear
    const ratio = oldDelta / freshDelta;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });
});

describe('shouldAutoAcceptProposal', () => {
  function proposedTask(overrides: Partial<Task> = {}): Task {
    return task({
      scheduleStatus: 'proposed',
      proposedTime: new Date(NOW.getTime() + DAY).toISOString(),
      proposedAt: NOW.toISOString(),
      ...overrides,
    });
  }

  it('is false when autoAcceptProposedSchedule is off', () => {
    const t = proposedTask();
    const later = new Date(NOW.getTime() + AUTO_ACCEPT_DELAY_MS + MINUTE);
    expect(shouldAutoAcceptProposal(t, settings({ autoAcceptProposedSchedule: false }), later)).toBe(false);
  });

  it('is false before 24 hours have passed', () => {
    const t = proposedTask();
    const soon = new Date(NOW.getTime() + AUTO_ACCEPT_DELAY_MS - MINUTE);
    expect(shouldAutoAcceptProposal(t, settings({ autoAcceptProposedSchedule: true }), soon)).toBe(false);
  });

  it('is true once 24 hours have passed with the setting on', () => {
    const t = proposedTask();
    const later = new Date(NOW.getTime() + AUTO_ACCEPT_DELAY_MS + MINUTE);
    expect(shouldAutoAcceptProposal(t, settings({ autoAcceptProposedSchedule: true }), later)).toBe(true);
  });

  it('is false once the task is no longer proposed -- dismissing or accepting already moved it off "proposed"', () => {
    const later = new Date(NOW.getTime() + AUTO_ACCEPT_DELAY_MS + MINUTE);
    const dismissed = proposedTask({ scheduleStatus: 'unscheduled', proposedTime: null });
    expect(shouldAutoAcceptProposal(dismissed, settings({ autoAcceptProposedSchedule: true }), later)).toBe(
      false,
    );
    const confirmed = proposedTask({ scheduleStatus: 'confirmed' });
    expect(shouldAutoAcceptProposal(confirmed, settings({ autoAcceptProposedSchedule: true }), later)).toBe(
      false,
    );
  });

  it('is false when proposedAt is missing -- a task persisted before the field existed', () => {
    const t = proposedTask({ proposedAt: undefined });
    const later = new Date(NOW.getTime() + AUTO_ACCEPT_DELAY_MS + MINUTE);
    expect(shouldAutoAcceptProposal(t, settings({ autoAcceptProposedSchedule: true }), later)).toBe(false);
  });
});

describe('proposeSlot, performance', () => {
  it('handles a two-week horizon with 400 signals and 100 occupied tasks quickly', () => {
    const signals = Array.from({ length: 400 }, (_, i) =>
      signal({
        dayOfWeek: (i % 7) as SchedulingSignal['dayOfWeek'],
        hourOfDay: 8 + (i % 14),
        outcome: i % 3 === 0 ? 'skipped' : 'completed',
        recordedAt: new Date(NOW.getTime() - (i % 25) * DAY).toISOString(),
      }),
    );
    const others = Array.from({ length: 100 }, (_, i) =>
      task({
        id: `busy-${i}`,
        startTime: new Date(NOW.getTime() + i * 3 * HOUR).toISOString(),
        durationMinutes: 30,
        scheduleStatus: 'confirmed',
      }),
    );
    const started = Date.now();
    const p = proposeSlot(
      input({
        signals,
        otherTasks: others,
        task: task({ dueDate: new Date(NOW.getTime() + 14 * DAY).toISOString() }),
      }),
    );
    const elapsed = Date.now() - started;
    expect(p).not.toBeNull();
    // generous: this runs on every task creation, so an O(slots x signals) regression should be loud
    expect(elapsed).toBeLessThan(500);
  });
});

describe('blockLengthMultiplier, applied to block length (SCHEDULING.md 3b)', () => {
  function ratioSignal(ratio: number, overrides: Partial<SchedulingSignal> = {}): SchedulingSignal {
    return signal({ estimatedDurationMinutes: 30, actualDurationMinutes: 30 * ratio, ...overrides });
  }

  it('is exactly 1.0 below five samples with both an actual and an estimated duration', () => {
    const four = Array.from({ length: 4 }, () => ratioSignal(1.5));
    expect(blockLengthMultiplier(four)).toBe(1.0);
    const withMissing = [
      ...four,
      signal({ estimatedDurationMinutes: null, actualDurationMinutes: 90 }),
      signal({ estimatedDurationMinutes: 30, actualDurationMinutes: null }),
    ];
    expect(blockLengthMultiplier(withMissing)).toBe(1.0);
  });

  it('a chronic underestimator gets longer blocks once there is enough evidence', () => {
    const five = Array.from({ length: 5 }, () => ratioSignal(1.5));
    expect(blockLengthMultiplier(five)).toBeCloseTo(1.5, 5);

    const p = proposeSlot(
      input({ signals: five, task: task({ durationMinutes: 40 }) }),
    );
    expect(p).not.toBeNull();
    const actualMinutes = (new Date(p!.endIso).getTime() - new Date(p!.startIso).getTime()) / MINUTE;
    expect(actualMinutes).toBeCloseTo(60, 5);
  });

  it('clamps to [0.6, 2.0] so one wild session cannot produce an unusable block', () => {
    const extremeLong = Array.from({ length: 6 }, () => ratioSignal(5));
    expect(blockLengthMultiplier(extremeLong)).toBe(2.0);
    const extremeShort = Array.from({ length: 6 }, () => ratioSignal(0.1));
    expect(blockLengthMultiplier(extremeShort)).toBe(0.6);
  });
});

describe('scoreSlot, daily capacity (SCHEDULING.md 3c)', () => {
  function mondaysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 7 * DAY);
  }

  // four observed mondays, enough to clear MIN_OBSERVATIONS_FOR_CAPACITY
  function learnedMondaySessions(minutesEach = 60): FocusSession[] {
    return [1, 2, 3, 4].map((n) =>
      session({
        id: `monday-${n}`,
        startedAt: mondaysAgo(n).toISOString(),
        endedAt: new Date(mondaysAgo(n).getTime() + minutesEach * MINUTE).toISOString(),
        durationSeconds: minutesEach * 60,
      }),
    );
  }

  it('learns a capacity for a weekday with four observed occurrences', () => {
    const capacity = buildCapacityContext([], learnedMondaySessions(60), settings(), NOW);
    const monday = capacity.capacityByWeekday.get(1);
    expect(monday?.learned).toBe(true);
    expect(monday?.minutes).toBeCloseTo(60, 0);
  });

  it('falls back to typicalSessionMinutes * 2 with fewer than three observations', () => {
    const oneObservation = [session({ startedAt: mondaysAgo(1).toISOString(), durationSeconds: 60 * 60 })];
    const capacity = buildCapacityContext([], oneObservation, settings({ typicalSessionMinutes: 20 }), NOW);
    const monday = capacity.capacityByWeekday.get(1);
    expect(monday?.learned).toBe(false);
    expect(monday?.minutes).toBe(40);
  });

  it("a day at capacity stops accepting work: penalised past it, discarded past 1.25x, untouched below it", () => {
    const sessions = learnedMondaySessions(60); // monday's learned capacity is about 60 minutes
    const at = new Date(2026, 8, 7, 11, 0, 0, 0).getTime(); // later the same monday
    const durationMs = 25 * MINUTE;
    const baseInput = input({ sessions, settings: settings() });
    const history = buildHistory([], NOW);

    const committed = (minutes: number): Task[] => [
      task({
        id: 'earlier-today',
        startTime: new Date(2026, 8, 7, 9, 0, 0, 0).toISOString(),
        durationMinutes: minutes,
        scheduleStatus: 'confirmed',
      }),
    ];

    // 0 + 25 = 25, under the 60-minute capacity
    const underCapacity = buildCapacityContext([], sessions, settings(), NOW);
    const scoreUnder = scoreSlot(at, durationMs, baseInput, history, [], underCapacity);
    const scoreWithNoCapacityData = scoreSlot(at, durationMs, baseInput, history, []);
    expect(scoreUnder).toBeCloseTo(scoreWithNoCapacityData, 6);

    // 40 + 25 = 65: over capacity but under the 1.25x discard line (75), so penalised
    const overCapacity = buildCapacityContext(committed(40), sessions, settings(), NOW);
    const scoreOver = scoreSlot(at, durationMs, baseInput, history, [], overCapacity);
    expect(scoreOver).toBeCloseTo(scoreUnder + WEIGHTS.dayCapacity, 6);
    expect(65).toBeLessThan(60 * DAY_CAPACITY_DISCARD_MULTIPLIER);

    // 60 + 25 = 85: past the discard line, so discarded outright
    expect(85).toBeGreaterThan(60 * DAY_CAPACITY_DISCARD_MULTIPLIER);
    const pastDiscard = buildCapacityContext(committed(60), sessions, settings(), NOW);
    const scoreDiscarded = scoreSlot(at, durationMs, baseInput, history, [], pastDiscard);
    expect(scoreDiscarded).toBe(Number.NEGATIVE_INFINITY);
  });

  it('proposeSlot moves a task to a different day once today is already at capacity', () => {
    const sessions = learnedMondaySessions(60);
    const other = task({
      id: 'earlier-today',
      startTime: new Date(2026, 8, 7, 9, 0, 0, 0).toISOString(),
      durationMinutes: 55,
      scheduleStatus: 'confirmed',
    });
    const p = proposeSlot(
      input({
        settings: settings({ energyPeakStart: 0, energyPeakEnd: 0 }),
        sessions,
        otherTasks: [other],
        task: task({ durationMinutes: 60, dueDate: new Date(NOW.getTime() + 4 * DAY).toISOString() }),
      }),
    );
    expect(p).not.toBeNull();
    // 55 + 60 = 115, past today's discard line for every slot, so it lands on a later day
    expect(new Date(p!.startIso).getDate()).not.toBe(7);
  });
});

describe('forecastFeasibility (SCHEDULING.md 3d)', () => {
  function feasibilityInput(overrides: Partial<Parameters<typeof forecastFeasibility>[0]> = {}) {
    return {
      task: task(),
      otherTasks: [],
      sessions: [],
      settings: settings(),
      signals: [],
      now: NOW,
      ...overrides,
    };
  }

  it('reports a task with a distant due date and light load as fitting', () => {
    const result = forecastFeasibility(
      feasibilityInput({
        task: task({ dueDate: new Date(NOW.getTime() + 4 * DAY).toISOString(), durationMinutes: 45 }),
      }),
    );
    expect(result.fits).toBe(true);
    expect(result.requiredMinutes).toBe(45);
  });

  it('reports a task that cannot fit before its deadline as not fitting', () => {
    const result = forecastFeasibility(
      feasibilityInput({
        task: task({
          dueDate: new Date(NOW.getTime() + 5 * MINUTE).toISOString(),
          durationMinutes: 45,
        }),
      }),
    );
    expect(result.fits).toBe(false);
    expect(result.availableMinutes).toBeLessThan(result.requiredMinutes);
  });

  it('accounts for a calibrated (not just planned) duration', () => {
    const chronicUnderestimate = Array.from({ length: 5 }, () =>
      signal({ estimatedDurationMinutes: 30, actualDurationMinutes: 60 }),
    );
    const result = forecastFeasibility(
      feasibilityInput({
        task: task({ dueDate: new Date(NOW.getTime() + 4 * DAY).toISOString(), durationMinutes: 30 }),
        signals: chronicUnderestimate,
      }),
    );
    expect(result.requiredMinutes).toBeCloseTo(60, 5);
  });

  it('already-placed work and a due date past has zero free time report as not fitting', () => {
    const due = new Date(NOW.getTime() - DAY);
    const result = forecastFeasibility(feasibilityInput({ task: task({ dueDate: due.toISOString() }) }));
    expect(result.fits).toBe(false);
    expect(result.availableMinutes).toBe(0);
  });
});

describe('canReplaceBlock (SCHEDULING.md section 4)', () => {
  const soon = new Date(NOW.getTime() + 3 * HOUR).toISOString();

  it('rule 1: never moves a block that has already started or passed', () => {
    const past = new Date(NOW.getTime() - HOUR).toISOString();
    expect(
      canReplaceBlock({
        currentStartIso: past,
        currentScheduleStatus: 'confirmed',
        currentScore: 0,
        candidateScore: 100,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rule 2: never moves a block starting within the next two hours', () => {
    const withinTwoHours = new Date(NOW.getTime() + 90 * MINUTE).toISOString();
    expect(
      canReplaceBlock({
        currentStartIso: withinTwoHours,
        currentScheduleStatus: 'confirmed',
        currentScore: 0,
        candidateScore: 100,
        now: NOW,
      }),
    ).toBe(false);
    const justOverTwoHours = new Date(NOW.getTime() + 2 * HOUR + MINUTE).toISOString();
    expect(
      canReplaceBlock({
        currentStartIso: justOverTwoHours,
        currentScheduleStatus: 'confirmed',
        currentScore: 0,
        candidateScore: 100,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rule 3: never moves a pinned block, no matter how large the improvement', () => {
    expect(
      canReplaceBlock({
        currentStartIso: soon,
        currentScheduleStatus: 'pinned',
        currentScore: -100,
        candidateScore: 100,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rule 4: an auto block only moves once the new slot scores enough better', () => {
    const base = {
      currentStartIso: new Date(NOW.getTime() + DAY).toISOString(),
      currentScheduleStatus: 'proposed',
      currentScore: 1,
      now: NOW,
    };
    expect(canReplaceBlock({ ...base, candidateScore: 1 + REPLACEMENT_IMPROVEMENT_THRESHOLD - 0.01 })).toBe(
      false,
    );
    expect(canReplaceBlock({ ...base, candidateScore: 1 + REPLACEMENT_IMPROVEMENT_THRESHOLD })).toBe(true);
  });

  it('a task with no current placement is always a first placement, never a move', () => {
    expect(
      canReplaceBlock({
        currentStartIso: null,
        currentScheduleStatus: 'unscheduled',
        currentScore: 0,
        candidateScore: 0,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('proposeSlot, anti-thrash (SCHEDULING.md section 4)', () => {
  it('never moves a block that has already started or passed', () => {
    const startedStart = new Date(2026, 8, 7, 8, 0, 0, 0); // an hour before NOW
    const placed = task({
      startTime: startedStart.toISOString(),
      scheduleStatus: 'confirmed',
      durationMinutes: 30,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const p = proposeSlot(
      input({ task: placed, settings: settings({ energyPeakStart: 15, energyPeakEnd: 17 }) }),
    );
    expect(p).not.toBeNull();
    expect(p!.startIso).toBe(startedStart.toISOString());
  });

  it('never moves a block starting within the next two hours', () => {
    const soonStart = new Date(NOW.getTime() + 30 * MINUTE);
    const placed = task({
      startTime: soonStart.toISOString(),
      scheduleStatus: 'confirmed',
      durationMinutes: 30,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const p = proposeSlot(
      input({ task: placed, settings: settings({ energyPeakStart: 15, energyPeakEnd: 17 }) }),
    );
    expect(p).not.toBeNull();
    expect(p!.startIso).toBe(soonStart.toISOString());
  });

  it('never moves a pinned block, even to a clearly better slot', () => {
    const pinnedStart = new Date(NOW.getTime() + DAY); // far enough out that timing alone would not block it
    const placed = task({
      startTime: pinnedStart.toISOString(),
      scheduleStatus: 'pinned' as unknown as Task['scheduleStatus'],
      durationMinutes: 30,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const p = proposeSlot(
      input({ task: placed, settings: settings({ energyPeakStart: 15, energyPeakEnd: 17 }) }),
    );
    expect(p).not.toBeNull();
    expect(p!.startIso).toBe(pinnedStart.toISOString());
  });

  it('moves an auto block once a new slot scores enough better, but not for a marginal gain', () => {
    // outside the energy window and far enough out that only the score threshold applies
    const mediocreStart = new Date(2026, 8, 8, 6, 0, 0, 0); // tuesday 06:00, well outside 15-17
    const placed = task({
      startTime: mediocreStart.toISOString(),
      scheduleStatus: 'confirmed',
      durationMinutes: 30,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const p = proposeSlot(
      input({ task: placed, settings: settings({ energyPeakStart: 15, energyPeakEnd: 17 }) }),
    );
    expect(p).not.toBeNull();
    // the energy window (+2) alone clears the 0.75 improvement bar
    expect(p!.startIso).not.toBe(mediocreStart.toISOString());
    const hour = new Date(p!.startIso).getHours();
    expect(hour).toBeGreaterThanOrEqual(15);
    expect(hour).toBeLessThan(17);
  });
});


describe('canReplaceBlock: a slot that stopped being a slot', () => {
  const NOW_LOCAL = new Date('2026-09-07T08:00:00');
  const inSixHours = new Date(NOW_LOCAL.getTime() + 6 * 60 * 60_000).toISOString();

  it('moves an auto block whose slot is no longer usable, even with no score gain', () => {
    // a busy block declared after placement now covers the slot. comparing scores cannot see
    // that, so without this flag the block sat inside busy time on device
    expect(
      canReplaceBlock({
        currentStartIso: inSixHours,
        currentScheduleStatus: 'auto',
        currentScore: 10,
        candidateScore: 0,
        currentSlotUnusable: true,
        now: NOW_LOCAL,
      }),
    ).toBe(true);
  });

  it('still refuses to move a pinned block whose slot is no longer usable', () => {
    expect(
      canReplaceBlock({
        currentStartIso: inSixHours,
        currentScheduleStatus: 'pinned',
        currentScore: 0,
        candidateScore: 10,
        currentSlotUnusable: true,
        now: NOW_LOCAL,
      }),
    ).toBe(false);
  });

  it('still refuses to move a block starting within two hours, usable or not', () => {
    expect(
      canReplaceBlock({
        currentStartIso: new Date(NOW_LOCAL.getTime() + 30 * 60_000).toISOString(),
        currentScheduleStatus: 'auto',
        currentScore: 0,
        candidateScore: 10,
        currentSlotUnusable: true,
        now: NOW_LOCAL,
      }),
    ).toBe(false);
  });
});

// corrupted inputs from an imported backup. each of these used to hang or throw at launch
describe('scheduler, hostile inputs', () => {
  it('proposeSlot returns null at once for a negative duration instead of walking forever', () => {
    const started = Date.now();
    expect(proposeSlot(input({ task: task({ durationMinutes: -1e9 }) }))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('proposeSlot returns null for a non-positive fallback session length', () => {
    expect(
      proposeSlot(input({ task: task({ durationMinutes: null }), settings: settings({ typicalSessionMinutes: -30 }) })),
    ).toBeNull();
    expect(proposeSlot(input({ task: task({ durationMinutes: 0 }) }))).toBeNull();
  });

  it('proposeSlot treats an unparseable current start as not placed rather than throwing', () => {
    const bad = task({ scheduleStatus: 'auto', startTime: 'x' });
    let proposal: ReturnType<typeof proposeSlot> = null;
    expect(() => {
      proposal = proposeSlot(input({ task: bad }));
    }).not.toThrow();
    expect(proposal).not.toBeNull();
    expect(Number.isFinite(Date.parse(proposal!.startIso))).toBe(true);
  });

  it('forecastFeasibility caps its day walk instead of iterating to year 9999', () => {
    const started = Date.now();
    const result = forecastFeasibility({
      task: task({ dueDate: '9999-12-31T23:59:00.000Z', durationMinutes: 60 }),
      otherTasks: [],
      sessions: [],
      settings: settings({
        calendarEvents: [
          {
            id: 'e1',
            title: 'Practice',
            date: '2026-09-01',
            startTime: '15:00',
            endTime: '16:00',
            repeatDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            createdAt: NOW.toISOString(),
          },
        ],
      }),
      signals: [],
      now: NOW,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.fits).toBe(true);
  });
});
