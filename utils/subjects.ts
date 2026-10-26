// subject recall is a local frequency list, never generated
import type { Task } from '@/types';

export const MAX_SUBJECT_SUGGESTIONS = 4;

export function subjectsByFrequency(tasks: readonly Task[]): string[] {
  const stats = new Map<string, { count: number; lastUsedAt: string }>();

  for (const task of tasks) {
    const subject = task.subject?.trim();
    if (!subject) continue;
    const existing = stats.get(subject);
    if (existing) {
      existing.count += 1;
      if (task.createdAt > existing.lastUsedAt) existing.lastUsedAt = task.createdAt;
    } else {
      stats.set(subject, { count: 1, lastUsedAt: task.createdAt });
    }
  }

  return Array.from(stats.entries())
    .sort(([, a], [, b]) => {
      if (a.count !== b.count) return b.count - a.count;
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    })
    .map(([subject]) => subject);
}

export function subjectSuggestions(tasks: readonly Task[], query: string): string[] {
  const all = subjectsByFrequency(tasks);
  const needle = query.trim().toLowerCase();
  const matching = needle ? all.filter((subject) => subject.toLowerCase().includes(needle)) : all;
  return matching.slice(0, MAX_SUBJECT_SUGGESTIONS);
}
