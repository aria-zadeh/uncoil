// exact prompt-token backstop on device. clampNotes keeps prompts under budget with an upper-bound
// estimate, but pathological text (walls of random letters, non-latin prose) can still tokenize higher.
// rare, so losing the end of the free-text field beats overrunning max_seq_len
import type { Prompt } from '@/services/prompt';

// the exported model's max_seq_len
export const MAX_SEQ_LEN = 1024;

export const MAX_NEW_TOKENS = 320;

export const PROMPT_TOKEN_CEILING = MAX_SEQ_LEN - MAX_NEW_TOKENS;

// chat template tokens around the two turns, which countTokens never sees. measured 16 with the bundled
// tokenizer, 24 leaves room for bos and merges at the string boundaries
export const CHAT_TEMPLATE_TOKEN_ALLOWANCE = 24;

// async because the real one is a native call (TokenizerModule.encode)
export type TokenCounter = (text: string) => Promise<number>;

// last whitespace boundary at or before maxLength, never splitting a surrogate pair. hard cut if none
function lastSafeBoundary(text: string, maxLength: number): number {
  if (maxLength >= text.length) return text.length;
  if (maxLength <= 0) return 0;

  let cut = maxLength;
  // a low surrogate at cut means cut - 1 holds its high half
  const codeUnit = text.charCodeAt(cut);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) cut -= 1;

  const slice = text.slice(0, cut);
  const trailingWordMatch = /\s+\S*$/.exec(slice);
  if (trailingWordMatch && trailingWordMatch.index > 0) {
    return trailingWordMatch.index;
  }
  return cut;
}

// field() collapses whitespace, so each field is exactly one line
function freeTextSpan(user: string): { start: number; end: number } | null {
  const match = /^(?:Details|Text): /m.exec(user);
  if (!match) return null;
  const start = match.index + match[0].length;
  const newline = user.indexOf('\n', start);
  return { start, end: newline === -1 ? user.length : newline };
}

// relies on token count never decreasing as text grows, which holds for bpe
async function longestFittingPrefix(
  text: string,
  candidate: (prefixLength: number) => string,
  budget: number,
  countTokens: TokenCounter,
): Promise<number> {
  // invariant: low always fits, high never does
  let low = 0;
  let high = text.length;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const candidateTokens = await countTokens(candidate(mid));
    if (candidateTokens <= budget) low = mid;
    else high = mid;
  }
  return lastSafeBoundary(text, low);
}

// cuts the free-text line (Details: or Text:) first, since trimming from the end would lose Due:,
// Session length: and Rejected:, the fields the model needs most. binary search because each count is
// a native round trip, about 11 calls for a 2000-character field
export async function enforceDeviceTokenBudget(
  prompt: Prompt,
  countTokens: TokenCounter,
): Promise<Prompt> {
  const systemTokens = await countTokens(prompt.system);
  const budget = PROMPT_TOKEN_CEILING - CHAT_TEMPLATE_TOKEN_ALLOWANCE - systemTokens;
  if (budget <= 0) {
    return prompt.user === '' ? prompt : { ...prompt, user: '' };
  }

  const user = prompt.user;
  const userTokens = await countTokens(user);
  if (userTokens <= budget) return prompt;

  const span = freeTextSpan(user);
  if (span !== null) {
    const head = user.slice(0, span.start);
    const content = user.slice(span.start, span.end);
    const tail = user.slice(span.end);
    if ((await countTokens(head + tail)) <= budget) {
      const cut = await longestFittingPrefix(
        content,
        (length) => head + content.slice(0, length) + tail,
        budget,
        countTokens,
      );
      return { ...prompt, user: head + content.slice(0, cut) + tail };
    }
  }

  const cut = await longestFittingPrefix(user, (length) => user.slice(0, length), budget, countTokens);
  return { ...prompt, user: user.slice(0, cut) };
}
