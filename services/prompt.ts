// part of the model contract. train/prompt.py emits byte-identical strings (prompt-parity.test.ts),
// so changing anything here means retraining. dates go out as relative phrases and are resolved in
// typescript, small models are bad at date math
import type { BreakdownInput, SimplifyInput } from '@/types';

export interface Prompt {
  system: string;
  user: string;
}

// reproduced verbatim in train/prompt.py
export const SYSTEM_BREAKDOWN =
  'Break the assignment into 3 to 7 physical steps. Respond with JSON only.';

// one model, three tasks, told apart by the system message
export const SYSTEM_EXTRACTION =
  'Find the assignments and their due dates in the text. Respond with JSON only.';

export const SYSTEM_SIMPLIFY =
  'Rewrite the assignment in plainer words for a sixth-grade reader. Respond with JSON only.';

// extraction also gets today's weekday so "due friday" resolves to a day count
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

// monday first, to match WEEKDAYS
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7];
}

const NONE = 'none';

const MS_PER_DAY = 86_400_000;

// counted in calendar days so "tomorrow" means tomorrow at any time of day
export function daysUntil(due: Date, now: Date): number {
  const dueMidnight = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const nowMidnight = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dueMidnight - nowMidnight) / MS_PER_DAY);
}

// closed set. training data uses exactly these phrases, anything else is a silent quality loss
export function relativeDuePhrase(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === 7) return 'next week';
  if (days === 14) return 'in 2 weeks';
  if (days < 14) return `in ${days} days`;
  if (days < 21) return 'in 2 weeks';
  if (days < 28) return 'in 3 weeks';
  const months = Math.round(days / 30);
  return months <= 1 ? 'in a month' : `in ${months} months`;
}

export function duePhraseFor(dueDateIso: string, now: Date): string {
  return relativeDuePhrase(daysUntil(new Date(dueDateIso), now));
}

// one line per field, a raw newline would break the record format the model was trained on
function field(value: string | null): string {
  if (value === null) return NONE;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? NONE : cleaned;
}

export function buildBreakdownPrompt(input: BreakdownInput): Prompt {
  const user = [
    `Assignment: ${field(input.title)}`,
    `Subject: ${field(input.subject)}`,
    `Details: ${field(input.description)}`,
    `Due: ${field(input.duePhrase)}`,
    `Session length: ${input.sessionMinutes}`,
  ].join('\n');
  return { system: SYSTEM_BREAKDOWN, user };
}

export function buildExtractionPrompt(chunk: string, today: Weekday = 'Monday'): Prompt {
  return { system: SYSTEM_EXTRACTION, user: `Today: ${today}\nText: ${field(chunk)}` };
}

export function buildSimplifyPrompt(input: SimplifyInput): Prompt {
  const user = [
    `Assignment: ${field(input.title)}`,
    `Details: ${field(input.description)}`,
  ].join('\n');
  return { system: SYSTEM_SIMPLIFY, user };
}

// exactly one retry. another round costs the student seconds for very little gain
export function buildRepairPrompt(original: Prompt, reason: string): Prompt {
  return {
    system: original.system,
    user: `${original.user}\n\nRejected: ${reason}. Respond again with JSON only.`,
  };
}

// paragraphs, then sentences, then a hard split, so no chunk is ever over budget
export function chunkForExtraction(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
  const chunks: string[] = [];
  let current = '';

  const push = () => {
    if (current.trim() !== '') chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      push();
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        let rest = sentence;
        while (rest.length > maxChars) {
          chunks.push(rest.slice(0, maxChars).trim());
          rest = rest.slice(maxChars);
        }
        if (current.length + rest.length + 1 > maxChars) push();
        current = current === '' ? rest : `${current} ${rest}`;
      }
      push();
      continue;
    }
    if (current.length + paragraph.length + 2 > maxChars) push();
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  push();
  return chunks;
}
