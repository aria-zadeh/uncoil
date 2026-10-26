import { describe, expect, it } from 'vitest';

import { MAX_SUBJECT_SUGGESTIONS, subjectSuggestions, subjectsByFrequency } from '@/utils/subjects';
import type { Task } from '@/types';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Untitled',
    subject: null,
    description: null,
    dueDate: '2026-09-10T00:00:00.000Z',
    startTime: null,
    proposedTime: null,
    durationMinutes: null,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('subjectsByFrequency', () => {
  it('returns an empty list when no task has a subject', () => {
    const tasks = [task({ id: '1', subject: null }), task({ id: '2', subject: '' })];
    expect(subjectsByFrequency(tasks)).toEqual([]);
  });

  it('orders distinct subjects by how often they were used, most first', () => {
    const tasks = [
      task({ id: '1', subject: 'History', createdAt: '2026-09-01T00:00:00.000Z' }),
      task({ id: '2', subject: 'English 2H', createdAt: '2026-09-02T00:00:00.000Z' }),
      task({ id: '3', subject: 'History', createdAt: '2026-09-03T00:00:00.000Z' }),
      task({ id: '4', subject: 'History', createdAt: '2026-09-04T00:00:00.000Z' }),
      task({ id: '5', subject: 'English 2H', createdAt: '2026-09-05T00:00:00.000Z' }),
    ];
    expect(subjectsByFrequency(tasks)).toEqual(['History', 'English 2H']);
  });

  it('breaks a frequency tie by recency, most recently used first', () => {
    const tasks = [
      task({ id: '1', subject: 'Chemistry', createdAt: '2026-09-01T00:00:00.000Z' }),
      task({ id: '2', subject: 'Art', createdAt: '2026-09-05T00:00:00.000Z' }),
    ];
    expect(subjectsByFrequency(tasks)).toEqual(['Art', 'Chemistry']);
  });

  it('deduplicates a subject used many times into one entry', () => {
    const tasks = [
      task({ id: '1', subject: 'Spanish 3' }),
      task({ id: '2', subject: 'Spanish 3' }),
      task({ id: '3', subject: 'Spanish 3' }),
    ];
    expect(subjectsByFrequency(tasks)).toEqual(['Spanish 3']);
  });

  it('ignores a subject that is null, empty, or only whitespace', () => {
    const tasks = [
      task({ id: '1', subject: null }),
      task({ id: '2', subject: '' }),
      task({ id: '3', subject: '   ' }),
      task({ id: '4', subject: 'Biology' }),
    ];
    expect(subjectsByFrequency(tasks)).toEqual(['Biology']);
  });

  it('trims a subject before counting it, so padded and unpadded entries merge', () => {
    const tasks = [task({ id: '1', subject: 'Geometry' }), task({ id: '2', subject: '  Geometry  ' })];
    expect(subjectsByFrequency(tasks)).toEqual(['Geometry']);
  });
});

describe('subjectSuggestions', () => {
  const tasks = [
    task({ id: '1', subject: 'History', createdAt: '2026-09-01T00:00:00.000Z' }),
    task({ id: '2', subject: 'History', createdAt: '2026-09-02T00:00:00.000Z' }),
    task({ id: '3', subject: 'English 2H', createdAt: '2026-09-03T00:00:00.000Z' }),
    task({ id: '4', subject: 'Biology', createdAt: '2026-09-04T00:00:00.000Z' }),
    task({ id: '5', subject: 'Art', createdAt: '2026-09-05T00:00:00.000Z' }),
    task({ id: '6', subject: 'Algebra II', createdAt: '2026-09-06T00:00:00.000Z' }),
  ];

  it('returns the plain frequency list, capped at four, for an empty query', () => {
    const result = subjectSuggestions(tasks, '');
    expect(result).toHaveLength(MAX_SUBJECT_SUGGESTIONS);
    expect(result).toEqual(['History', 'Algebra II', 'Art', 'Biology']);
  });

  it('filters to subjects containing what has been typed, case-insensitively', () => {
    expect(subjectSuggestions(tasks, 'hist')).toEqual(['History']);
    expect(subjectSuggestions(tasks, 'ENGLISH')).toEqual(['English 2H']);
  });

  it('matches a substring anywhere in the subject, not only a prefix', () => {
    expect(subjectSuggestions(tasks, '2h')).toEqual(['English 2H']);
  });

  it('returns nothing when no subject matches', () => {
    expect(subjectSuggestions(tasks, 'chemistry')).toEqual([]);
  });

  it('never returns more than the maximum even when every subject matches', () => {
    const manySubjects = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, subject: `Subject ${i}`, createdAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    expect(subjectSuggestions(manySubjects, '')).toHaveLength(MAX_SUBJECT_SUGGESTIONS);
  });
});
