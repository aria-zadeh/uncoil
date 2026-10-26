import { describe, expect, it } from 'vitest';

import {
  jaccard,
  stripToJson,
  validateBreakdown,
  validateExtraction,
  validateSimplification,
  validateTaskTiming,
} from '@/services/validation';
import type { BreakdownInput, RejectionCode, SimplifyInput, ValidationResult } from '@/types';

const INPUT: BreakdownInput = {
  title: 'Write a 5-paragraph essay on The Great Gatsby',
  subject: 'English 2H',
  description: null,
  duePhrase: 'in 3 days',
  sessionMinutes: 30,
};

// passes every check. mutated per test to isolate failures
function goodBreakdown(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    steps: [
      { title: 'Open the assignment sheet and read the prompt out loud', minutes: 5 },
      { title: 'Write down the three points the essay has to make', minutes: 10 },
      { title: 'Write the introduction without stopping to edit', minutes: 20 },
      { title: 'Write the three body paragraphs', minutes: 45 },
      { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
    ],
    starterAction: 'Open the assignment sheet and read the prompt out loud',
    ...overrides,
  });
}

function codeOf<T>(result: ValidationResult<T>): RejectionCode | 'ok' {
  return result.ok ? 'ok' : result.rejection.code;
}

describe('stripToJson', () => {
  it('returns a bare object unchanged', () => {
    expect(stripToJson('{"a":1}')).toBe('{"a":1}');
  });

  it('removes markdown fences, which small models emit despite instructions', () => {
    expect(stripToJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripToJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('discards a prose preamble and a prose epilogue', () => {
    expect(stripToJson('Sure! Here is the breakdown:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('stops at the matching brace rather than the last brace in the buffer', () => {
    // taking the last `}` would swallow the trailing sentence
    const raw = '{"a":1} and then you should study {more}';
    expect(stripToJson(raw)).toBe('{"a":1}');
  });

  it('ignores braces inside string literals', () => {
    const raw = '{"note":"use the {template} file"}';
    expect(stripToJson(raw)).toBe(raw);
  });

  it('ignores escaped quotes inside string literals', () => {
    const raw = '{"note":"she said \\"go\\" first"}';
    expect(stripToJson(raw)).toBe(raw);
  });

  it('handles nested objects', () => {
    const raw = '{"a":{"b":{"c":1}}}';
    expect(stripToJson(raw)).toBe(raw);
  });

  it('returns null when there is no object at all', () => {
    expect(stripToJson('')).toBeNull();
    expect(stripToJson('no json here')).toBeNull();
    expect(stripToJson('[1,2,3]')).toBeNull();
  });

  it('returns null when the object never closes', () => {
    expect(stripToJson('{"steps":[{"title":"Open the book"')).toBeNull();
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is 1 when both sets are empty', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('is 0 when only one set is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('validateBreakdown, happy path', () => {
  it('accepts a well-formed response', () => {
    const result = validateBreakdown(goodBreakdown(), INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps).toHaveLength(5);
      expect(result.value.starterAction).toContain('Open the assignment sheet');
    }
  });

  it('accepts a response wrapped in fences and preamble', () => {
    const wrapped = `Here you go:\n\`\`\`json\n${goodBreakdown()}\n\`\`\``;
    expect(validateBreakdown(wrapped, INPUT).ok).toBe(true);
  });

  it('accepts the minimum and maximum step counts', () => {
    const three = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read the prompt', minutes: 10 },
        { title: 'Write the essay body', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Open the assignment sheet and read the prompt',
    });
    expect(validateBreakdown(three, INPUT).ok).toBe(true);

    const seven = JSON.stringify({
      steps: Array.from({ length: 7 }, (_, i) => ({
        title: `Write paragraph number ${i + 1} of the essay`,
        minutes: 10,
      })),
      starterAction: 'Write paragraph number 1 of the essay',
    });
    expect(validateBreakdown(seven, INPUT).ok).toBe(true);
  });
});

describe('validateBreakdown, malformed input', () => {
  const cases: [string, string, RejectionCode][] = [
    ['empty string', '', 'empty_output'],
    ['whitespace only', '   \n  ', 'empty_output'],
    ['prose with no object', 'I think you should start by planning.', 'no_json_object'],
    // stripping to the first `{` pulls out the first element, which then fails the schema,
    // so the repair reason still names what was wrong
    ['a JSON array of objects', '[{"title":"Open the book","minutes":5}]', 'missing_field'],
    ['a JSON array of scalars', '[1,2,3]', 'no_json_object'],
    ['truncated object', '{"steps":[{"title":"Open the book","minutes":5}', 'no_json_object'],
    ['trailing comma', '{"steps":[],"starterAction":"Open the book now",}', 'parse_error'],
    ['single quotes', "{'steps':[],'starterAction':'Open the book now'}", 'parse_error'],
    ['unquoted keys', '{steps:[],starterAction:"Open the book now"}', 'parse_error'],
    ['a JSON string', '"just a string"', 'no_json_object'],
    ['a JSON number', '42', 'no_json_object'],
    ['null', 'null', 'no_json_object'],
  ];

  for (const [name, raw, expected] of cases) {
    it(`rejects ${name} with ${expected}`, () => {
      expect(codeOf(validateBreakdown(raw, INPUT))).toBe(expected);
    });
  }
});

describe('validateBreakdown, schema', () => {
  it('rejects a missing field', () => {
    expect(codeOf(validateBreakdown('{"steps":[]}', INPUT))).toBe('missing_field');
    expect(codeOf(validateBreakdown('{"starterAction":"Open the book now"}', INPUT))).toBe(
      'missing_field',
    );
  });

  it('rejects an unexpected field, because additionalProperties is false', () => {
    const raw = goodBreakdown({ confidence: 0.9 });
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('unexpected_field');
  });

  it('rejects an unexpected field inside a step', () => {
    const raw = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 10, priority: 'high' },
        { title: 'Write the essay body', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('unexpected_field');
  });

  it('rejects too few and too many steps', () => {
    const two = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 10 },
        { title: 'Write the whole essay in one go', minutes: 40 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(two, INPUT))).toBe('too_few_steps');

    const eight = JSON.stringify({
      steps: Array.from({ length: 8 }, (_, i) => ({
        title: `Write paragraph number ${i + 1} of the essay`,
        minutes: 10,
      })),
      starterAction: 'Write paragraph number 1 of the essay',
    });
    expect(codeOf(validateBreakdown(eight, INPUT))).toBe('too_many_steps');
  });

  it('names the actual count in the rejection, so repair can be specific', () => {
    const nine = JSON.stringify({
      steps: Array.from({ length: 9 }, (_, i) => ({
        title: `Write paragraph number ${i + 1} of the essay`,
        minutes: 10,
      })),
      starterAction: 'Write paragraph number 1 of the essay',
    });
    const result = validateBreakdown(nine, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe('there were 9 steps, the maximum is 7');
  });

  it('rejects a step title that is too short or too long', () => {
    const short = JSON.stringify({
      steps: [
        { title: 'Go', minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Go and open the assignment',
    });
    expect(codeOf(validateBreakdown(short, INPUT))).toBe('title_too_short');

    const long = JSON.stringify({
      steps: [
        { title: `Open ${'the assignment sheet '.repeat(6)}`, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Open the assignment sheet',
    });
    expect(codeOf(validateBreakdown(long, INPUT))).toBe('title_too_long');
  });

  it('rejects non-integer and out-of-range minutes', () => {
    const fractional = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 10.5 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(fractional, INPUT))).toBe('minutes_not_integer');

    const stringMinutes = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: '10' },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(stringMinutes, INPUT))).toBe('minutes_not_integer');

    for (const minutes of [0, 4, 46, 120, -5]) {
      const raw = JSON.stringify({
        steps: [
          { title: 'Open the assignment sheet and read it', minutes },
          { title: 'Write the essay body paragraphs', minutes: 30 },
          { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
        ],
        starterAction: 'Open the assignment sheet and read it',
      });
      expect(codeOf(validateBreakdown(raw, INPUT))).toBe('minutes_out_of_range');
    }
  });

  it('rejects a starterAction outside its length bounds', () => {
    expect(codeOf(validateBreakdown(goodBreakdown({ starterAction: 'Open' }), INPUT))).toBe(
      'starter_action_length',
    );
    expect(
      codeOf(validateBreakdown(goodBreakdown({ starterAction: 'Open the sheet '.repeat(20) }), INPUT)),
    ).toBe('starter_action_length');
  });

  it('rejects wrong types for steps and starterAction', () => {
    expect(codeOf(validateBreakdown('{"steps":"three","starterAction":"Open the book now"}', INPUT))).toBe(
      'wrong_type',
    );
    expect(codeOf(validateBreakdown(goodBreakdown({ starterAction: 42 }), INPUT))).toBe('wrong_type');
  });
});

describe('validateBreakdown, semantic checks', () => {
  function withFirstStep(title: string, starter = title): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: starter,
    });
  }

  it('rejects the vague deny list, which is the failure that matters most', () => {
    for (const title of [
      'Plan your essay carefully',
      'Think about what you want to say',
      'Consider the main themes',
      'Decide on your thesis',
      'Brainstorm some ideas first',
      'Figure out what the prompt wants',
      'Work on the introduction',
      'Start on the first paragraph',
      'Prepare to write the essay',
      'Get ready to start writing',
    ]) {
      expect(codeOf(validateBreakdown(withFirstStep(title), INPUT))).toBe('vague_verb');
    }
  });

  it('catches a vague phrase in the middle of a title, not only at the start', () => {
    const raw = withFirstStep('Read the chapter and think about the themes');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('vague_verb');
  });

  it('does not match a deny-list word inside a longer word', () => {
    // "plan" must not match "planetary"
    const raw = withFirstStep('Draw the planetary orbit diagram');
    expect(codeOf(validateBreakdown(raw, INPUT))).not.toBe('vague_verb');
  });

  it('rejects a first word that is not an imperative action verb', () => {
    for (const title of [
      'Your essay needs three points',
      'Maybe look at the rubric first',
      'Essay introduction paragraph',
    ]) {
      expect(codeOf(validateBreakdown(withFirstStep(title), INPUT))).toBe('not_a_physical_action');
    }
  });

  it('rejects a total outside 15 to 300 minutes', () => {
    const tiny = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 5 },
        { title: 'Write one sentence of the essay', minutes: 5 },
        { title: 'Read the sentence back to yourself', minutes: 5 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    // 15 exactly is inside the range
    expect(codeOf(validateBreakdown(tiny, INPUT))).toBe('ok');

    const huge = JSON.stringify({
      steps: Array.from({ length: 7 }, () => ({
        title: 'Write the essay body paragraphs',
        minutes: 45,
      })),
      starterAction: 'Write the essay body paragraphs',
    });
    // 7 * 45 = 315, over the cap, but duplicates fire first
    expect(codeOf(validateBreakdown(huge, INPUT))).toBe('duplicate_step');

    const overLong = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 45 },
        { title: 'Write the introduction paragraph', minutes: 45 },
        { title: 'Write the first body paragraph', minutes: 45 },
        { title: 'Write the second body paragraph', minutes: 45 },
        { title: 'Write the third body paragraph', minutes: 45 },
        { title: 'Write the conclusion paragraph', minutes: 45 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 45 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(overLong, INPUT))).toBe('total_minutes_out_of_range');
  });

  it('rejects a starterAction that does not restate the first step', () => {
    const raw = withFirstStep(
      'Open the assignment sheet and read the prompt',
      'Gather every source you might possibly need',
    );
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('starter_action_mismatch');
  });

  it('accepts a starterAction that restates the first step in different words', () => {
    const raw = withFirstStep(
      'Open the assignment sheet and read the prompt',
      'Open the assignment sheet, then read the prompt',
    );
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('ok');
  });

  it('rejects a duplicated step title', () => {
    const raw = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('duplicate_step');
  });

  it('treats punctuation and case differences as the same duplicate step', () => {
    const raw = JSON.stringify({
      steps: [
        { title: 'Open the assignment sheet and read it', minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'write the essay body paragraphs.', minutes: 30 },
      ],
      starterAction: 'Open the assignment sheet and read it',
    });
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('duplicate_step');
  });

  it('rejects a proper noun the model invented', () => {
    const raw = withFirstStep('Read the chapter about Gatsby and Daisy Buchanan');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('hallucinated_proper_noun');
  });

  it('accepts a proper noun that came from the assignment', () => {
    // "Gatsby" is in the title
    const raw = withFirstStep('Read the Gatsby chapters listed on the sheet');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('ok');
  });

  it('does not flag the sentence-initial verb as an invented proper noun', () => {
    // capitalized and unsourced, but it is the sentence-initial verb, which the verb check covers
    const raw = withFirstStep('Annotate the essay prompt with your own words');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('ok');
  });

  it('accepts common sentence words that happen to be capitalized mid-title', () => {
    const raw = withFirstStep('Read the prompt, Then write the three points down');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('ok');
  });

  it('still splits on a non-breaking space between words', () => {
    const raw = withFirstStep('Read about Daisy Buchanan now');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('hallucinated_proper_noun');
  });
});

describe('validateBreakdown, possessive proper nouns', () => {
  it('accepts a possessive that is sourced from the assignment title', () => {
    const input: BreakdownInput = { ...INPUT, title: "Ohm's law problem set" };
    const raw = withFirstStepInput("Open Ohm's law problem set and read the first page");
    expect(codeOf(validateBreakdown(raw, input))).toBe('ok');
  });

  it('still rejects an unsourced possessive proper noun', () => {
    const input: BreakdownInput = { ...INPUT, title: "Ohm's law problem set" };
    const raw = withFirstStepInput("Read about Newton's third law before starting");
    expect(codeOf(validateBreakdown(raw, input))).toBe('hallucinated_proper_noun');
  });

  function withFirstStepInput(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }
});

describe('validateBreakdown, curly-apostrophe possessives', () => {
  function withFirstStepInput(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }

  it('accepts a curly-apostrophe possessive sourced from the assignment title', () => {
    // a curly apostrophe must survive token stripping like a straight one, or "Ohm’s" becomes
    // "Ohms" and the possessive check never fires
    const input: BreakdownInput = { ...INPUT, title: "Ohm's law problem set" };
    const raw = withFirstStepInput('Open Ohm’s law problem set and read the first page');
    expect(codeOf(validateBreakdown(raw, input))).toBe('ok');
  });

  it('still rejects an unsourced curly-apostrophe possessive', () => {
    const input: BreakdownInput = { ...INPUT, title: 'Write a lab report on cellular respiration' };
    const raw = withFirstStepInput('Read Gatsby’s notes before starting');
    expect(codeOf(validateBreakdown(raw, input))).toBe('hallucinated_proper_noun');
  });
});

describe('validateBreakdown, possessive stem requires a possessive shape', () => {
  function withFirstStepInput(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }
  const input: BreakdownInput = { ...INPUT, title: "Ohm's law problem set" };

  it('rejects a hallucinated suffix riding along a sourced possessive prefix', () => {
    // regression: taking everything before the first apostrophe let "Ohm'sGatsbyNotes" pass.
    // the token has to end in an apostrophe, optionally followed by "s"
    const raw = withFirstStepInput("Open Ohm'sGatsbyNotes and read the first page");
    expect(codeOf(validateBreakdown(raw, input))).toBe('hallucinated_proper_noun');
  });

  it('still accepts the genuine possessive', () => {
    const raw = withFirstStepInput("Open Ohm's law problem set and read the first page");
    expect(codeOf(validateBreakdown(raw, input))).toBe('ok');
  });
});

describe('validateBreakdown, "review" and "verify" are not imperative openers', () => {
  function withFirstStep(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }

  it('rejects both as a step-opening verb', () => {
    // reviewing or verifying is not an observable action distinct from reading or checking
    for (const title of ['Review the notes before the test', 'Verify the answer key against the textbook']) {
      expect(codeOf(validateBreakdown(withFirstStep(title), INPUT))).toBe('not_a_physical_action');
    }
  });
});

describe('validateBreakdown, widened verb whitelist', () => {
  function withFirstStep(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }

  it('accepts verbs added for assignment-specific tasks', () => {
    for (const title of ['Prove the next ten proofs', 'Glaze the bowl and let it dry']) {
      expect(codeOf(validateBreakdown(withFirstStep(title), INPUT))).toBe('ok');
    }
  });
});

describe('validateBreakdown, single-word vague entries match only the first word', () => {
  function withFirstStep(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }

  it('accepts a concrete instruction that merely contains a deny-listed word', () => {
    for (const title of [
      'Describe the process of photosynthesis',
      'Draw the floor plan for the set',
      'Solve for x to determine the slope',
      'Copy the twenty words you need to learn',
    ]) {
      expect(codeOf(validateBreakdown(withFirstStep(title), INPUT))).toBe('ok');
    }
  });

  it('still rejects the same word when it opens the title', () => {
    expect(codeOf(validateBreakdown(withFirstStep('Think about the essay'), INPUT))).toBe('vague_verb');
    expect(codeOf(validateBreakdown(withFirstStep('Plan the essay'), INPUT))).toBe('vague_verb');
  });
});

describe('validateBreakdown, everyday assignment nouns in common-capitalized', () => {
  function withFirstStep(title: string): string {
    return JSON.stringify({
      steps: [
        { title, minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: title,
    });
  }

  it('accepts a step naming a common tool word absent from the prompt', () => {
    const raw = withFirstStep('Open the Google Doc and start typing');
    expect(codeOf(validateBreakdown(raw, INPUT))).toBe('ok');
  });

  it('still rejects a genuinely invented proper noun', () => {
    const input: BreakdownInput = { ...INPUT, title: 'Write a reading response', subject: null };
    const raw = withFirstStep('Read the assigned chapter about Gatsby closely');
    expect(codeOf(validateBreakdown(raw, input))).toBe('hallucinated_proper_noun');
  });

  // regression: a photosynthesis breakdown fell back to a template seven runs in ten because
  // the model named the Calvin cycle. named curriculum concepts live in common-capitalized.txt
  it('accepts a curriculum named concept absent from the prompt', () => {
    const input: BreakdownInput = {
      ...INPUT,
      title: 'Photosynthesis presentation',
      subject: 'Biology',
      description: 'Five slides on the light reactions',
    };
    const raw = withFirstStep('Write the Calvin cycle slide');
    expect(codeOf(validateBreakdown(raw, input))).toBe('ok');
    const acronyms = withFirstStep('Label where ATP and NADPH are made');
    expect(codeOf(validateBreakdown(acronyms, input))).toBe('ok');
  });

  it('still rejects an invented character on a curriculum assignment', () => {
    const input: BreakdownInput = { ...INPUT, title: 'Read chapters 4 and 5', subject: 'English', description: null };
    const raw = withFirstStep('Write down what Mayella says in the courtroom scene');
    expect(codeOf(validateBreakdown(raw, input))).toBe('hallucinated_proper_noun');
  });
});

describe('validateBreakdown, adversarial assignment input', () => {
  const adversarial: [string, BreakdownInput][] = [
    ['empty title', { ...INPUT, title: '' }],
    ['single emoji', { ...INPUT, title: '\u{1F600}' }],
    ['one character', { ...INPUT, title: 'a' }],
    ['500 characters of noise', { ...INPUT, title: 'qx9 '.repeat(125) }],
    ['non-Latin script', { ...INPUT, title: '寿司の宿題' }],
    ['already atomic', { ...INPUT, title: 'Sign the permission slip' }],
    ['mild profanity', { ...INPUT, title: 'this damn essay on The Great Gatsby' }],
    ['no subject or details', { ...INPUT, subject: null, description: null }],
    ['very long description', { ...INPUT, description: 'context '.repeat(200) }],
  ];

  for (const [name, input] of adversarial) {
    it(`returns a verdict without throwing for ${name}`, () => {
      // the validator is total: every input gets an accept or a rejection, never an exception
      expect(() => validateBreakdown(goodBreakdown(), input)).not.toThrow();
      const result = validateBreakdown(goodBreakdown(), input);
      expect(typeof result.ok).toBe('boolean');
    });
  }

  it('still rejects a hallucinated noun when the assignment title is empty', () => {
    const raw = JSON.stringify({
      steps: [
        { title: 'Read the chapter about Daisy Buchanan closely', minutes: 10 },
        { title: 'Write the essay body paragraphs', minutes: 30 },
        { title: 'Read it aloud and fix what sounds wrong', minutes: 15 },
      ],
      starterAction: 'Read the chapter about Daisy closely',
    });
    expect(codeOf(validateBreakdown(raw, { ...INPUT, title: '', subject: null }))).toBe(
      'hallucinated_proper_noun',
    );
  });
});

describe('validateExtraction', () => {
  it('accepts a well-formed response', () => {
    const raw = JSON.stringify({
      tasks: [
        { title: 'Read chapters 4 to 6', dueInDays: 3, subject: 'English' },
        { title: 'Lab report', dueInDays: 7 },
      ],
    });
    const result = validateExtraction(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tasks).toHaveLength(2);
  });

  it('accepts an empty task list', () => {
    expect(validateExtraction('{"tasks":[]}').ok).toBe(true);
  });

  it('rejects more than the maximum number of tasks', () => {
    const raw = JSON.stringify({
      tasks: Array.from({ length: 9 }, (_, i) => ({ title: `Task number ${i}`, dueInDays: 1 })),
    });
    expect(codeOf(validateExtraction(raw))).toBe('too_many_tasks');
  });

  it('rejects a due offset outside 0 to 365', () => {
    expect(codeOf(validateExtraction('{"tasks":[{"title":"Read it","dueInDays":-1}]}'))).toBe(
      'due_in_days_out_of_range',
    );
    expect(codeOf(validateExtraction('{"tasks":[{"title":"Read it","dueInDays":400}]}'))).toBe(
      'due_in_days_out_of_range',
    );
  });

  it('accepts the boundary values', () => {
    expect(validateExtraction('{"tasks":[{"title":"Read it","dueInDays":0}]}').ok).toBe(true);
    expect(validateExtraction('{"tasks":[{"title":"Read it","dueInDays":365}]}').ok).toBe(true);
  });

  it('rejects an over-long subject', () => {
    const raw = JSON.stringify({
      tasks: [{ title: 'Read it', dueInDays: 1, subject: 'x'.repeat(41) }],
    });
    expect(codeOf(validateExtraction(raw))).toBe('subject_too_long');
  });

  it('rejects an unexpected field', () => {
    const raw = JSON.stringify({ tasks: [{ title: 'Read it', dueInDays: 1, priority: 1 }] });
    expect(codeOf(validateExtraction(raw))).toBe('unexpected_field');
  });

  it('omits subject entirely when it was absent, rather than emitting undefined', () => {
    const result = validateExtraction('{"tasks":[{"title":"Read it","dueInDays":1}]}');
    expect(result.ok).toBe(true);
    if (result.ok) expect('subject' in result.value.tasks[0]).toBe(false);
  });
});

describe('validateSimplification', () => {
  const input: SimplifyInput = {
    title: 'Analyze the rhetorical devices in the assigned speech',
    description: null,
  };

  it('accepts a well-formed response', () => {
    const raw = JSON.stringify({
      title: 'Find the persuasion tricks in the speech',
      explanation:
        'Read the speech and mark the places where the speaker tries to convince you. Say what each one does.',
    });
    expect(validateSimplification(raw, input).ok).toBe(true);
  });

  it('rejects an explanation outside its length bounds', () => {
    expect(
      codeOf(validateSimplification('{"title":"Find the tricks","explanation":"Too short"}', input)),
    ).toBe('explanation_length');

    const long = JSON.stringify({
      title: 'Find the tricks',
      explanation: 'word '.repeat(120),
    });
    expect(codeOf(validateSimplification(long, input))).toBe('explanation_length');
  });

  it('rejects a proper noun the model invented in the title', () => {
    const raw = JSON.stringify({
      title: 'Find the persuasion tricks in the Gettysburg speech',
      explanation:
        'Read the speech and mark the places where the speaker tries to convince you of something.',
    });
    expect(codeOf(validateSimplification(raw, input))).toBe('hallucinated_proper_noun');
  });

  it('rejects a missing field', () => {
    expect(codeOf(validateSimplification('{"title":"Find the tricks"}', input))).toBe('missing_field');
  });
});

describe('validateTaskTiming', () => {
  it('accepts a null start time regardless of the due date', () => {
    const result = validateTaskTiming({ dueDate: '2026-09-10T00:00:00.000Z', startTime: null });
    expect(result.ok).toBe(true);
  });

  it('accepts a start time before the due date', () => {
    const result = validateTaskTiming({
      dueDate: '2026-09-10T18:00:00.000Z',
      startTime: '2026-09-10T15:00:00.000Z',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a start time exactly at the due date', () => {
    const result = validateTaskTiming({
      dueDate: '2026-09-10T15:00:00.000Z',
      startTime: '2026-09-10T15:00:00.000Z',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a start time after the due date', () => {
    const result = validateTaskTiming({
      dueDate: '2026-09-10T00:00:00.000Z',
      startTime: '2026-09-11T09:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.code).toBe('start_time_after_due_date');
  });

  it('does not reject an unparseable date -- that is not this check\'s job', () => {
    const result = validateTaskTiming({ dueDate: 'not-a-date', startTime: 'also-not-a-date' });
    expect(result.ok).toBe(true);
  });
});
