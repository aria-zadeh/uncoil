import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import {
  BACKUP_FORMAT_VERSION,
  buildBackup,
  parseBackup,
  serializeBackup,
} from '@/services/backup';
import { generateDemoData } from '@/services/demoSeed';
import {
  MIN_SIGNALS_FOR_CALIBRATION,
  MIN_SIGNALS_FOR_WINDOW,
  blockLengthMultiplier,
  completionCounts,
  currentStreak,
  estimateCalibration,
  isOverdue,
  productiveWindow,
} from '@/services/insights';
import type { DemoData } from '@/services/demoSeed';

const NOW = new Date(2026, 8, 7, 18, 0, 0, 0); // monday evening

function serialize(demo: DemoData): string {
  return serializeBackup(
    buildBackup({
      tasks: demo.tasks,
      sessions: demo.sessions,
      signals: demo.signals,
      settings: DEFAULT_SETTINGS,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      now: NOW,
    }),
  );
}

describe('generateDemoData', () => {
  it('is deterministic for a given now', () => {
    expect(generateDemoData(NOW)).toEqual(generateDemoData(NOW));
  });

  it('produces the advertised volume and status mix', () => {
    const { tasks, sessions, signals } = generateDemoData(NOW);
    expect(tasks).toHaveLength(28);
    expect(sessions).toHaveLength(34);
    expect(signals.length).toBeGreaterThanOrEqual(44);

    const statuses = tasks.map((t) => t.status);
    expect(statuses).toContain('complete');
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('not_started');
    expect(tasks.filter((t) => t.completedAt !== null)).toHaveLength(
      statuses.filter((s) => s === 'complete').length,
    );
  });

  it('leaves something in the Overdue tab', () => {
    const { tasks } = generateDemoData(NOW);
    const overdue = tasks.filter((t) => t.status === 'not_started' && isOverdue(t, NOW));
    expect(overdue.length).toBeGreaterThanOrEqual(1);
  });

  it('references only ids it generated', () => {
    const { tasks, sessions, signals } = generateDemoData(NOW);
    const taskIds = new Set(tasks.map((t) => t.id));

    for (const task of tasks) {
      for (const subtask of task.subtasks) {
        expect(subtask.parentTaskId).toBe(task.id);
      }
    }
    for (const session of sessions) {
      expect(taskIds.has(session.taskId)).toBe(true);
    }
    for (const signal of signals) {
      if (signal.taskId !== null) expect(taskIds.has(signal.taskId)).toBe(true);
    }
  });

  // the backup validators are strict, so this proves the seed actually imports on device
  it('survives a round trip through parseBackup', () => {
    const result = parseBackup(
      serialize(generateDemoData(NOW)),
      CURRENT_SCHEMA_VERSION,
      BACKUP_FORMAT_VERSION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.tasks).toHaveLength(28);
    expect(result.file.sessions).toHaveLength(34);
  });
});

describe('generateDemoData insight thresholds', () => {
  it('clears the productive window threshold with an unambiguous winner', () => {
    const { signals } = generateDemoData(NOW);
    expect(signals.length).toBeGreaterThanOrEqual(MIN_SIGNALS_FOR_WINDOW);

    const window = productiveWindow(signals);
    expect(window).not.toBeNull();
    if (window === null) return;
    expect(window.sampleCount).toBeGreaterThanOrEqual(3);
    expect(window.completionRate).toBeGreaterThan(0.7);
    expect(window.completionRate).toBeLessThan(1);
  });

  it('calibrates estimates at a median ratio between 1.4 and 1.6', () => {
    const { signals } = generateDemoData(NOW);
    const calibration = estimateCalibration(signals);
    expect(calibration).not.toBeNull();
    if (calibration === null) return;
    expect(calibration.sampleCount).toBeGreaterThanOrEqual(MIN_SIGNALS_FOR_CALIBRATION);
    expect(calibration.ratio).toBeGreaterThanOrEqual(1.4);
    expect(calibration.ratio).toBeLessThanOrEqual(1.6);
  });

  it('moves the scheduler off the still-learning multiplier', () => {
    const { signals } = generateDemoData(NOW);
    expect(blockLengthMultiplier(signals)).not.toBe(1);
  });

  it('has a live streak and recent completions', () => {
    const { tasks } = generateDemoData(NOW);
    expect(currentStreak(tasks, NOW)).toBeGreaterThan(0);

    const week = completionCounts(tasks, NOW, 7);
    expect(week.completed).toBeGreaterThan(0);
    expect(completionCounts(tasks, NOW, 30).completed).toBeGreaterThan(week.completed);
  });

  it('mixes outcomes rather than completing everything', () => {
    const { signals } = generateDemoData(NOW);
    const outcomes = new Set(signals.map((s) => s.outcome));
    expect(outcomes).toEqual(new Set(['completed', 'partial', 'skipped']));
  });
});
