import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_TEMPLATE_TOKEN_ALLOWANCE,
  MAX_NEW_TOKENS,
  MAX_SEQ_LEN,
  PROMPT_TOKEN_CEILING,
  enforceDeviceTokenBudget,
  type TokenCounter,
} from '@/services/deviceTokenBudget';
import type { Prompt } from '@/services/prompt';

// monotonic, which is all enforceDeviceTokenBudget assumes of a real tokenizer
const oneTokenPerChar: TokenCounter = async (text) => text.length;

// several characters per token, so the search runs against something other than string length
function charsPerToken(chars: number): TokenCounter {
  return async (text) => Math.ceil(text.length / chars);
}

function prompt(system: string, user: string): Prompt {
  return { system, user };
}

describe('constants', () => {
  it('reserves exactly the section 5.1 max_new_tokens out of the section 3.2 max_seq_len', () => {
    expect(MAX_SEQ_LEN).toBe(1024);
    expect(MAX_NEW_TOKENS).toBe(320);
    expect(PROMPT_TOKEN_CEILING).toBe(704);
  });
});

describe('within budget', () => {
  it('returns the same prompt reference unchanged, spending exactly two counts', async () => {
    const p = prompt('Break the assignment into steps.', 'Assignment: Write an essay\nDue: tomorrow');
    const countTokens = vi.fn(oneTokenPerChar);

    const result = await enforceDeviceTokenBudget(p, countTokens);

    expect(result).toBe(p);
    expect(countTokens).toHaveBeenCalledTimes(2);
  });
});

describe('over budget', () => {
  it('trims user until system + user fits the ceiling', async () => {
    const system = 'x'.repeat(50);
    const user = `Assignment: essay\nDetails: ${'lorem ipsum '.repeat(200)}\nDue: tomorrow`;
    const p = prompt(system, user);

    const result = await enforceDeviceTokenBudget(p, oneTokenPerChar);

    expect(result.system).toBe(system);
    expect(result.user.length).toBeLessThan(user.length);
    const totalTokens = result.system.length + result.user.length;
    expect(totalTokens).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  it('cuts at a word boundary, never mid-word', async () => {
    const system = 'sys';
    const user = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const p = prompt(system, user);

    const result = await enforceDeviceTokenBudget(p, charsPerToken(3));

    if (result.user.length < user.length) {
      const nextChar = user[result.user.length];
      expect(nextChar === ' ' || nextChar === undefined).toBe(true);
      expect(result.user.endsWith(' ')).toBe(false);
    }
    const totalTokens = Math.ceil(result.system.length / 3) + Math.ceil(result.user.length / 3);
    expect(totalTokens).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  it('converges under a coarser, non-one-to-one tokenizer', async () => {
    const system = 'Rewrite the assignment in plainer words.';
    const user = `Assignment: Essay\nDetails: ${'a'.repeat(5000)}`;
    const p = prompt(system, user);

    const result = await enforceDeviceTokenBudget(p, charsPerToken(4));

    const systemTokens = Math.ceil(result.system.length / 4);
    const userTokens = Math.ceil(result.user.length / 4);
    expect(systemTokens + userTokens).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  it('never produces a lone UTF-16 surrogate at the cut point', async () => {
    const system = 'sys';
    // placed so a naive binary-search cut lands inside the surrogate pair
    const user = 'a'.repeat(300) + '\u{1F600}' + 'b'.repeat(300);
    const p = prompt(system, user);

    const result = await enforceDeviceTokenBudget(p, oneTokenPerChar);

    const lastCode = result.user.charCodeAt(result.user.length - 1);
    const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
    expect(isLoneHighSurrogate).toBe(false);
  });
});

describe('the system message alone exceeds the ceiling', () => {
  it('empties user rather than searching a range with no solution', async () => {
    const system = 'x'.repeat(PROMPT_TOKEN_CEILING + 100);
    const p = prompt(system, 'Assignment: Essay\nDue: tomorrow');

    const result = await enforceDeviceTokenBudget(p, oneTokenPerChar);

    expect(result.user).toBe('');
    expect(result.system).toBe(system);
  });

  it('is a no-op, not a repeated allocation, when user is already empty', async () => {
    const system = 'x'.repeat(PROMPT_TOKEN_CEILING + 100);
    const p = prompt(system, '');

    const result = await enforceDeviceTokenBudget(p, oneTokenPerChar);

    expect(result).toBe(p);
  });
});

describe('chat template allowance', () => {
  it('leaves room for the ChatML wrapper the counter never sees', async () => {
    const system = 'x'.repeat(100);
    // fits the bare ceiling but not once the wrapper is counted
    const user = `Assignment: essay\nDetails: ${'y'.repeat(PROMPT_TOKEN_CEILING - 100 - 30)}`;
    expect(system.length + user.length).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);

    const result = await enforceDeviceTokenBudget(prompt(system, user), oneTokenPerChar);

    expect(result.system.length + result.user.length + CHAT_TEMPLATE_TOKEN_ALLOWANCE).toBeLessThanOrEqual(
      PROMPT_TOKEN_CEILING,
    );
  });
});

describe('which line is trimmed', () => {
  it('trims the breakdown Details line and keeps Due and Session length whole', async () => {
    const user = [
      'Assignment: Write an essay',
      'Subject: English',
      `Details: ${'lorem ipsum '.repeat(200).trim()}`,
      'Due: in 3 days',
      'Session length: 30',
    ].join('\n');

    const result = await enforceDeviceTokenBudget(prompt('sys', user), oneTokenPerChar);

    expect(result.user.length).toBeLessThan(user.length);
    expect(result.user.startsWith('Assignment: Write an essay\nSubject: English\nDetails: lorem')).toBe(true);
    expect(result.user.endsWith('\nDue: in 3 days\nSession length: 30')).toBe(true);
    expect(3 + result.user.length + CHAT_TEMPLATE_TOKEN_ALLOWANCE).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  it('keeps a repair prompt\'s Rejected instruction whole', async () => {
    const user = `Assignment: Essay\nDetails: ${'word '.repeat(300).trim()}\n\nRejected: too few steps. Respond again with JSON only.`;

    const result = await enforceDeviceTokenBudget(prompt('sys', user), oneTokenPerChar);

    expect(result.user.endsWith('\n\nRejected: too few steps. Respond again with JSON only.')).toBe(true);
    expect(result.user.length).toBeLessThan(user.length);
  });

  it('trims the extraction Text line', async () => {
    const user = `Today: Monday\nText: ${'Essay due Friday. '.repeat(100).trim()}`;

    const result = await enforceDeviceTokenBudget(prompt('sys', user), oneTokenPerChar);

    expect(result.user.startsWith('Today: Monday\nText: Essay due Friday.')).toBe(true);
    expect(3 + result.user.length + CHAT_TEMPLATE_TOKEN_ALLOWANCE).toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  it('cuts the Details line at a word boundary', async () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const user = `Assignment: Essay\nDetails: ${words}\nDue: tomorrow\nSession length: 30`;

    const result = await enforceDeviceTokenBudget(prompt('sys', user), oneTokenPerChar);

    const details = /Details: (.*)\n/.exec(result.user)![1];
    expect(words.startsWith(details)).toBe(true);
    const next = words[details.length];
    expect(next === ' ' || next === undefined).toBe(true);
  });
});
