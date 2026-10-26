// deterministic fallback breakdowns. a real shipped tier, held to the same validator as model output,
// so every step starts with an imperative verb and avoids the vague-phrase list
import { BREAKDOWN_LIMITS, type Breakdown, type BreakdownInput } from '@/types';

export type TemplatePattern =
  | 'writing'
  | 'reading'
  | 'problem_set'
  | 'study'
  | 'project'
  | 'generic';

interface PatternRule {
  pattern: TemplatePattern;
  keywords: readonly string[];
}

// first match wins, so specific words come before broad ones ("lab report" is writing)
const RULES: readonly PatternRule[] = [
  {
    pattern: 'problem_set',
    keywords: ['problem set', 'problems', 'worksheet', 'packet', 'exercises', 'math', 'algebra', 'geometry', 'calculus', 'statistics', 'equations', 'homework set'],
  },
  {
    pattern: 'study',
    keywords: ['study guide', 'study', 'quiz', 'test', 'exam', 'review sheet', 'review', 'memorize', 'memorise', 'flashcard', 'vocab'],
  },
  {
    pattern: 'writing',
    keywords: ['essay', 'paper', 'write', 'report', 'reflection', 'analysis', 'response', 'bibliography', 'outline'],
  },
  {
    pattern: 'reading',
    keywords: ['read', 'chapter', 'pages', 'article', 'novel', 'book', 'annotate'],
  },
  {
    pattern: 'project',
    keywords: ['project', 'presentation', 'poster', 'slides', 'build', 'model', 'experiment', 'lab'],
  },
];

export function classify(input: BreakdownInput): TemplatePattern {
  const haystack = [input.title, input.subject ?? '', input.description ?? '']
    .join(' ')
    .toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.pattern;
  }
  return 'generic';
}

function clampMinutes(value: number): number {
  return Math.min(
    BREAKDOWN_LIMITS.maxMinutes,
    Math.max(BREAKDOWN_LIMITS.minMinutes, Math.round(value)),
  );
}

// sized to the session length so someone who works in 20-minute stretches gets 20-minute steps
function block(sessionMinutes: number, fraction = 1): number {
  return clampMinutes(sessionMinutes * fraction);
}

type Step = { title: string; minutes: number };

function writing(session: number): Step[] {
  return [
    { title: 'Open the assignment sheet and read the prompt out loud', minutes: 5 },
    { title: 'List the three points the writing has to make', minutes: clampMinutes(session * 0.4) },
    { title: 'Collect the notes and quotes you already have', minutes: clampMinutes(session * 0.5) },
    { title: 'Write the opening paragraph without stopping to edit', minutes: block(session) },
    { title: 'Write the rest of the body in one sitting', minutes: block(session, 1.4) },
    { title: 'Read it aloud and fix what sounds wrong', minutes: clampMinutes(session * 0.5) },
  ];
}

function reading(session: number): Step[] {
  const chunk = clampMinutes(Math.min(20, session));
  return [
    { title: 'Open the reading and find where you left off', minutes: 5 },
    { title: 'Read the first section without stopping', minutes: chunk },
    { title: 'Write one sentence saying what that section was about', minutes: 5 },
    { title: 'Read the next section without stopping', minutes: chunk },
    { title: 'Write down the parts you did not follow', minutes: clampMinutes(session * 0.3) },
  ];
}

function problemSet(session: number): Step[] {
  return [
    { title: 'Open the worksheet and put your name on it', minutes: 5 },
    { title: 'Answer the first five questions in order', minutes: block(session) },
    { title: 'Answer the next five questions in order', minutes: block(session) },
    { title: 'Finish the questions that are left', minutes: block(session) },
    { title: 'Check your answers against the worked examples', minutes: clampMinutes(session * 0.5) },
  ];
}

function study(session: number): Step[] {
  return [
    { title: 'Open your notes and put them in date order', minutes: 5 },
    { title: 'Read the notes from the last two weeks', minutes: block(session) },
    { title: 'Write six questions you would ask yourself', minutes: clampMinutes(session * 0.5) },
    { title: 'Answer your own questions without looking', minutes: block(session) },
    { title: 'Answer again the ones you got wrong', minutes: clampMinutes(session * 0.5) },
  ];
}

function project(session: number): Step[] {
  return [
    { title: 'Open the assignment sheet and list what must be handed in', minutes: 10 },
    { title: 'Collect the materials and files you need', minutes: clampMinutes(session * 0.5) },
    { title: 'Make the first piece all the way through', minutes: block(session, 1.2) },
    { title: 'Make the rest of the pieces', minutes: block(session, 1.4) },
    { title: 'Put the pieces together in order', minutes: block(session, 0.7) },
    { title: 'Practise saying it out loud once', minutes: clampMinutes(session * 0.4) },
  ];
}

function generic(session: number): Step[] {
  return [
    { title: 'Open the materials for this and read the instructions', minutes: 5 },
    { title: 'Complete the first part in one sitting', minutes: block(session) },
    { title: 'Write down what is still left to do', minutes: 5 },
    { title: 'Finish the rest of it', minutes: block(session, 1.3) },
  ];
}

const BUILDERS: Record<TemplatePattern, (session: number) => Step[]> = {
  writing,
  reading,
  problem_set: problemSet,
  study,
  project,
  generic,
};

// no trimming needed: at most 6 steps capped at 45 minutes stays under the 7 step / 300 minute limits.
// templates.test.ts asserts it for every pattern
export function forTask(input: BreakdownInput): Breakdown {
  const pattern = classify(input);
  const session = Math.max(BREAKDOWN_LIMITS.minMinutes, input.sessionMinutes || 30);
  const steps = BUILDERS[pattern](session);
  return {
    steps,
    // same words as step one on purpose, the validator wants a content-word overlap
    starterAction: steps[0].title,
  };
}
