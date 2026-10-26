import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from '@/data/keys';
import { MemoryRepository } from '@/data/memoryRepository';
import { DEFAULT_SETTINGS } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import {
  cancel as cancelGeneration,
  generateBreakdown,
  getModelStatus,
  installModelRuntime,
} from '@/services/generation';
import { completionRate, highestPriorityTask } from '@/services/insights';
import { planNotifications } from '@/services/notificationPlan';
import { buildBreakdownPrompt, buildRepairPrompt, duePhraseFor } from '@/services/prompt';
import { proposeSlot } from '@/services/scheduler';
import { forTask } from '@/services/templates';
import { validateBreakdown } from '@/services/validation';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSessionStore } from '@/store/sessionStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore } from '@/store/taskStore';
import type { BreakdownInput, UserSettings } from '@/types';

// release blocker: the app makes no outbound request at all. if a new dependency
// fails this, the dependency is wrong, not this file

const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);

interface Attempt {
  api: string;
  target: string;
}

const attempts: Attempt[] = [];

const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

const originals = new Map<string, unknown>();

function installTraps(): void {
  attempts.length = 0;
  const g = globalThis as unknown as Record<string, unknown>;

  for (const name of NETWORK_GLOBALS) {
    originals.set(name, g[name]);
    g[name] = function trapped(...args: unknown[]) {
      attempts.push({ api: name, target: String(args[0] ?? '') });
      throw new Error(`${name} was called. The app makes zero network requests.`);
    };
  }

  originals.set('navigator.sendBeacon', (globalThis.navigator as { sendBeacon?: unknown } | undefined)?.sendBeacon);
  if (typeof globalThis.navigator === 'object' && globalThis.navigator !== null) {
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      configurable: true,
      value: (...args: unknown[]) => {
        attempts.push({ api: 'navigator.sendBeacon', target: String(args[0] ?? '') });
        throw new Error('navigator.sendBeacon was called.');
      },
    });
  }
}

function restoreTraps(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of NETWORK_GLOBALS) {
    const original = originals.get(name);
    if (original === undefined) delete g[name];
    else g[name] = original;
  }
}

function buildStores() {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs: 0 });
  let clock = NOW.getTime();
  let counter = 0;
  const base = {
    queue,
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => `id-${String(counter++).padStart(4, '0')}`,
  };
  const settings = createSettingsStore(base, {
    ...DEFAULT_SETTINGS,
    onboardingComplete: true,
    notificationsEnabled: true,
  });
  const scheduling = createSchedulingStore(base, []);
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      propose: ({ task, allTasks, settings: s, signals }) => {
        const slot = proposeSlot({
          task,
          otherTasks: allTasks.filter((t) => t.id !== task.id),
          settings: s as UserSettings,
          signals,
          now: NOW,
        });
        return slot === null ? null : { startTime: slot.startIso };
      },
    },
    [],
  );
  const sessions = createSessionStore(
    { ...base, taskStore: { getState: tasks.getState }, schedulingStore: { getState: scheduling.getState } },
    [],
  );
  return { repository, queue, settings, scheduling, tasks, sessions };
}

describe('no network', () => {
  beforeEach(installTraps);
  afterEach(restoreTraps);

  it('the full lifecycle attempts zero network requests', async () => {
    const ctx = buildStores();

    const id = ctx.tasks.getState().addTask({
      title: 'Write a 5-paragraph essay on The Great Gatsby',
      subject: 'English 2H',
      dueDate: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
      durationMinutes: 90,
    });

    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    const input: BreakdownInput = {
      title: task.title,
      subject: task.subject,
      description: task.description,
      duePhrase: duePhraseFor(task.dueDate, NOW),
      sessionMinutes: 30,
    };
    const prompt = buildBreakdownPrompt(input);
    buildRepairPrompt(prompt, 'there were 9 steps, the maximum is 7');

    const modelTier = validateBreakdown(
      JSON.stringify({
        steps: [
          { title: 'Open the assignment sheet and read the prompt out loud', minutes: 5 },
          { title: 'List the three points the essay has to make', minutes: 15 },
          { title: 'Write the introduction without stopping to edit', minutes: 25 },
          { title: 'Write the three body paragraphs', minutes: 40 },
          { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
        ],
        starterAction: 'Open the assignment sheet and read the prompt out loud',
      }),
      input,
    );
    expect(modelTier.ok).toBe(true);

    const templateTier = forTask(input);
    expect(validateBreakdown(JSON.stringify(templateTier), input).ok).toBe(true);

    // the real generation module, the one that wraps the model runtime
    installModelRuntime(null);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'unsupported' });
    const noRuntime = await generateBreakdown(input);
    expect(noRuntime.tier).toBe('template');

    installModelRuntime({
      load: () => Promise.resolve(),
      generate: () => Promise.resolve(JSON.stringify(templateTier)),
      status: () => ({ state: 'ready' }),
    });
    const withRuntime = await generateBreakdown(input);
    expect(withRuntime.tier).toBe('model');
    cancelGeneration();
    installModelRuntime(null);

    ctx.tasks.getState().addSubtasks(
      id,
      templateTier.steps.map((s) => ({ title: s.title, estimatedMinutes: s.minutes })),
    );

    ctx.tasks.getState().proposeSchedule(id);
    expect(ctx.tasks.getState().tasks.find((t) => t.id === id)!.startTime).not.toBeNull();

    planNotifications(ctx.tasks.getState().tasks, ctx.settings.getState(), NOW);

    ctx.sessions.getState().startSession(id, null);
    ctx.sessions.getState().startBreak();
    ctx.sessions.getState().endBreak(300);
    ctx.sessions.getState().endSession('completed');

    ctx.scheduling.getState().addSignal({
      taskId: id,
      dayOfWeek: 1,
      hourOfDay: 15,
      outcome: 'completed',
      actualDurationMinutes: 95,
      estimatedDurationMinutes: 90,
    });
    ctx.tasks.getState().completeTask(id);
    highestPriorityTask(ctx.tasks.getState().tasks, NOW);
    completionRate(ctx.tasks.getState().tasks, NOW, 30);

    await ctx.queue.flush();
    expect(ctx.repository.raw()[STORAGE_KEYS.tasks]).toBeDefined();

    expect(attempts, `network was attempted: ${JSON.stringify(attempts)}`).toEqual([]);
  });

  it('the traps themselves work, so a green result means something', () => {
    expect(() => (globalThis as unknown as { fetch: (u: string) => void }).fetch('https://example.com')).toThrow();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].api).toBe('fetch');
    attempts.length = 0;
  });
});

describe('no network, statically', () => {
  const SOURCE_DIRS = ['app', 'components', 'services', 'store', 'data', 'types', 'utils'];

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = require('node:fs').readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
      }
    };
    for (const dir of SOURCE_DIRS) walk(dir);
    return out;
  }

  it('no source module imports a Node network module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source module references a network client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bnew WebSocket\b/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the dependency list contains nothing that opens a socket', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const disqualified = [
      '@supabase/supabase-js',
      'axios',
      'node-fetch',
      'socket.io-client',
      'expo-secure-store',
      'react-native-web',
      '@sentry/react-native',
      'posthog-react-native',
      'firebase',
    ];
    const present = Object.keys(pkg.dependencies ?? {}).filter((d) => disqualified.includes(d));
    expect(present).toEqual([]);
  });

  it('really imports services/generation.ts, at the top level', () => {
    // regression: this guard once matched its own regex literal and could never fail. anchoring
    // to line start skips the indented literal, and the typeof checks prove the module loaded
    const source = readFileSync('__tests__/integration/no-network.test.ts', 'utf8');
    const imported = /^import [\s\S]*?from '@\/services\/generation';$/m.test(source);

    expect(existsSync('services/generation.ts')).toBe(true);
    expect(imported, 'services/generation.ts must be imported by this test').toBe(true);
    expect(typeof generateBreakdown).toBe('function');
    expect(typeof installModelRuntime).toBe('function');
  });
});
