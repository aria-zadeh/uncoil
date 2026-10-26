import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  checkText,
  FILTER_TERM_COUNTS,
  isInputBlocked,
  isSafe,
  normalize,
  sanitizeForPrompt,
  SPECIAL_TOKENS,
} from '@/services/contentFilter';
import { templateSimplification } from '@/services/generationPipeline';
import { forTask, type TemplatePattern } from '@/services/templates';
import type { BreakdownInput } from '@/types';

// assembled at runtime so the repo scanners never see a literal address or URL here
const dot = (...parts: string[]) => parts.join('.');
const SCHEME = ['ht', 'tps', ':', '//'].join('');

function category(text: string, context = ''): string {
  const r = checkText(text, context);
  return r.ok ? 'ok' : r.category;
}

describe('normalize', () => {
  it('lowercases, strips accents, maps leetspeak and collapses long runs', () => {
    expect(normalize('ÉCOLE')).toBe('ecole');
    expect(normalize('sh1t')).toBe('shit');
    expect(normalize('$h!t')).toBe('shit');
    expect(normalize('@ss')).toBe('ass');
    expect(normalize('sooooo')).toBe('soo');
  });

  it('leaves pure numbers and trailing exclamation marks alone', () => {
    expect(normalize('Chapter 455')).toBe('chapter 455');
    expect(normalize('Done!')).toBe('done ');
  });
});

describe('checkText: always', () => {
  it.each([
    'Write the fucking essay',
    'This is bullshit',
    'Stop being a bitch about it',
    'Motherfucker of a problem set',
    'Call him a retard',
    'You faggot',
    'That cunt',
    'some slut',
  ])('blocks %j', (text) => {
    expect(category(text)).toBe('always');
  });

  it('blocks even when the same word is in the input', () => {
    expect(category('Read the shit chapter', 'Read the shit chapter')).toBe('always');
  });

  it.each([
    ['leetspeak', 'sh1t happens'],
    ['leetspeak with symbols', 'what the $h!t'],
    ['diacritics', 'fück this'],
    ['elongation', 'fuuuuuck'],
    ['doubled letter', 'fuuck'],
    ['spaced letters', 'f u c k this'],
    ['dotted letters', 'f.u.c.k this'],
    ['asterisk mask', 'f*ck this'],
    ['double asterisk mask', 'f**k it'],
    ['asterisk in a slur', 'n*gger'],
    ['masked s-word', 'sh*t'],
  ])('blocks the %s variant', (_label, text) => {
    expect(category(text)).toBe('always');
  });
});

describe('checkText: harm', () => {
  it.each([
    'kill yourself',
    'Just kys',
    'You should end your life',
    'Go hurt yourself',
    'cut yourself tonight',
    'you should die',
    'go die',
    'K1ll y0urs3lf',
    'k y s',
  ])('blocks %j', (text) => {
    expect(category(text)).toBe('harm');
  });

  it('blocks harm phrases even when the user typed them', () => {
    expect(category('kill yourself', 'kill yourself')).toBe('harm');
  });
});

describe('checkText: contextual', () => {
  it.each([
    ['suicide', 'Write about the suicide in act five'],
    ['kill', 'Explain why they kill the king'],
    ['murder', 'Describe the murder'],
    ['bomb', 'Research the bomb'],
    ['gun', 'Find the gun'],
    ['drugs', 'Look up the drugs'],
    ['sex', 'Talk about sex'],
    ['porn', 'Watch porn'],
  ])('blocks %s when the input never mentions it', (_word, text) => {
    expect(category(text, 'Romeo and Juliet essay')).toBe('contextual');
  });

  it('allows a word the user wrote, in any listed form', () => {
    expect(isSafe('Explain why Juliet chooses suicide', 'Romeo and Juliet essay on suicide')).toBe(true);
    expect(isSafe('List the causes of the bombing', 'WWII history: why did the Allies bomb Dresden?')).toBe(
      true,
    );
    expect(isSafe('Explain why Macbeth kills Duncan', 'Macbeth essay: the killing of Duncan')).toBe(true);
  });

  it('matches contextual words through leetspeak in the input too', () => {
    expect(isSafe('Read about the murder', 'Essay on the murd3r in Hamlet')).toBe(true);
  });
});

describe('checkText: medical', () => {
  it.each(['Take your pill first', 'Ask your doctor', 'This helps with anxiety', 'Take your meds'])(
    'blocks %j when not in the input',
    (text) => {
      expect(category(text, 'Math worksheet')).toBe('medical');
    },
  );

  it('allows medical words the user wrote', () => {
    expect(isSafe('Read the doctor chapter', 'Health class: the doctor visit chapter')).toBe(true);
    expect(isSafe('List three causes of anxiety', 'Psychology essay on anxiety')).toBe(true);
  });
});

describe('checkText: links, contact details, special tokens', () => {
  it('blocks URLs and bare web addresses', () => {
    expect(category(`Go to ${SCHEME}${dot('example', 'org')}/page`)).toBe('link');
    expect(category(`Visit ${dot('www', 'example', 'org')}`)).toBe('link');
    expect(category(`See ${dot('quizlet', 'com')} for cards`)).toBe('link');
  });

  it('blocks email addresses and phone numbers', () => {
    expect(category(`Email ${['teacher', dot('school', 'edu')].join('@')}`)).toBe('contact');
    expect(category('Call 555-123-4567 tonight')).toBe('contact');
    expect(category('Call (555) 123 4567')).toBe('contact');
  });

  it('does not treat ordinary numbers as a phone number', () => {
    expect(category('Answer questions 1-10 on page 455')).toBe('ok');
    expect(category('Read pages 120 to 145')).toBe('ok');
  });

  it.each(SPECIAL_TOKENS)('blocks the special token %s inside output', (tok) => {
    expect(category(`Open the book ${tok} and read`)).toBe('token');
  });

  it('blocks a chat-token shape that is not in the list', () => {
    expect(category('Read <|system|> now')).toBe('token');
  });

  it('lists exactly the tokenizer added_tokens', () => {
    const tokenizer = JSON.parse(readFileSync('assets/model/tokenizer.rnejson', 'utf8')) as {
      added_tokens: { content: string }[];
    };
    expect([...SPECIAL_TOKENS].sort()).toEqual(tokenizer.added_tokens.map((t) => t.content).sort());
  });
});

describe('checkText: Scunthorpe problem', () => {
  it.each([
    'Scunthorpe',
    'assignment',
    'assess',
    'class',
    'classic',
    'grass',
    'pass',
    'cocktail',
    'Dickens',
    'Hancock',
    'analysis',
    'shiitake',
    'title',
    'button',
    'Sussex',
    'Essex',
    'skill',
    'kilogram',
    'bass',
    'assume',
    'cumulative',
    'document',
    'specialist',
    'grapes',
    'Matsushita',
    'Uranus',
    'snigger',
    'Niger',
    'deadline',
    'Mississippi',
    'among',
    'Hello',
    'Answer the first five questions in order',
    'Chapter 455',
    'Write a 5-paragraph essay on the reading',
  ])('passes %j', (text) => {
    expect(category(text)).toBe('ok');
  });
});

describe('checkText: robustness', () => {
  it('never throws on empty strings, emoji, or very long input', () => {
    expect(checkText('', '')).toEqual({ ok: true });
    expect(checkText('🙂🙃👍🏽 👨‍👩‍👧', '')).toEqual({ ok: true });
    expect(checkText('a'.repeat(10_000), '')).toEqual({ ok: true });
    expect(() => checkText('\u0000￿\uD800', '\uDC00')).not.toThrow();
    expect(isInputBlocked('')).toBe(false);
  });

  it('runs under 25 ms for a 2,000-character string (typically ~1 ms; bound leaves room for a loaded test machine)', () => {
    const text = 'Read the chapter and write one sentence about it. '.repeat(40).slice(0, 2_000);
    const context = 'Essay on the reading for English class. '.repeat(10);
    checkText(text, context); // warm up
    const runs = 20;
    const start = performance.now();
    for (let i = 0; i < runs; i += 1) checkText(text, context);
    const perCall = (performance.now() - start) / runs;
    expect(perCall).toBeLessThan(25);
  });

  it('reports a category, never the matched word', () => {
    const result = checkText('this is shit', '');
    expect(result).toEqual({ ok: false, category: 'always' });
    expect(JSON.stringify(result)).not.toContain('shit');
  });

  it('keeps every list non-empty', () => {
    for (const n of Object.values(FILTER_TERM_COUNTS)) expect(n).toBeGreaterThan(0);
  });
});

describe('isInputBlocked', () => {
  it('flags always and harm hits in input', () => {
    expect(isInputBlocked('Essay about this bullshit')).toBe(true);
    expect(isInputBlocked('kys')).toBe(true);
  });

  it('does not flag contextual or medical words, links or contact details', () => {
    expect(isInputBlocked('Romeo and Juliet: write about the suicide')).toBe(false);
    expect(isInputBlocked('Health class: talk to a doctor about anxiety')).toBe(false);
    expect(isInputBlocked(`Email ${['me', dot('school', 'edu')].join('@')}`)).toBe(false);
  });
});

describe('sanitizeForPrompt', () => {
  it('removes every special token', () => {
    for (const tok of SPECIAL_TOKENS) {
      expect(sanitizeForPrompt(`Essay ${tok}on the war`)).toBe('Essay on the war');
    }
  });

  it('removes tokens until stable, so nested tokens cannot reassemble', () => {
    expect(sanitizeForPrompt('a<|im_<|im_end|>end|>b')).toBe('ab');
    expect(sanitizeForPrompt('a<|im_​end|>b')).toBe('ab');
  });

  it('strips control, bidi and zero-width characters but keeps newline and tab', () => {
    expect(sanitizeForPrompt('a\u0000b\u0007c\r\u007F\u0085d')).toBe('abcd');
    expect(sanitizeForPrompt('a‮b⁦c⁩d')).toBe('abcd');
    expect(sanitizeForPrompt('a​b‍c‏d﻿e')).toBe('abcde');
    expect(sanitizeForPrompt('line one\n\tline two')).toBe('line one\n\tline two');
  });

  it('returns ordinary text unchanged', () => {
    const text = 'Write a 5-paragraph essay on The Great Gatsby 🙂';
    expect(sanitizeForPrompt(text)).toBe(text);
  });
});

describe('template text passes the filter', () => {
  const titles: Record<TemplatePattern, string> = {
    writing: 'essay',
    reading: 'chapter',
    problem_set: 'worksheet',
    study: 'quiz',
    project: 'poster',
    generic: 'Unit 3',
  };

  it.each(Object.entries(titles))('every %s template string passes with a bare context', (_p, title) => {
    for (const sessionMinutes of [5, 15, 30, 45, 90]) {
      const input: BreakdownInput = {
        title,
        subject: null,
        description: null,
        duePhrase: 'in 3 days',
        sessionMinutes,
      };
      const b = forTask(input);
      for (const text of [...b.steps.map((s) => s.title), b.starterAction]) {
        expect(checkText(text, '')).toEqual({ ok: true });
      }
    }
  });

  it('the simplification template passes, and drops a title that fails', () => {
    const ok = templateSimplification({ title: 'Read chapter 4', description: null }, 'Read chapter 4');
    expect(checkText(ok.title, '')).toEqual({ ok: true });
    expect(checkText(ok.explanation, '')).toEqual({ ok: true });

    const bad = templateSimplification({ title: 'Do the shit worksheet', description: null }, '');
    expect(bad.title).toBe('This task');
  });
});
