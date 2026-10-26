#!/usr/bin/env node
// generates the committed parity fixtures so the TS and python sides read one file.
// run once and commit the output. the validator corpus over-weights what a small
// model actually emits (fences, preambles, truncation, trailing commas, single
// quotes); a clean corpus would let two validators agree while differing where it matters
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

mkdirSync('__tests__/fixtures', { recursive: true });

// prompt fixtures

const SUBJECTS = [
  'English 2H', 'AP US History', 'Biology', 'Algebra II', 'Chemistry',
  'Spanish III', 'Geometry', 'AP Psychology', 'World Literature', 'Physics',
];
const ARTIFACTS = [
  'essay', 'lab report', 'problem set', 'presentation', 'reading response',
  'research paper', 'poster', 'study guide', 'worksheet', 'chapter notes',
];
const TOPICS = [
  'the causes of the Civil War', 'cellular respiration', 'quadratic functions',
  'The Great Gatsby chapters 4 through 6', 'the periodic table', 'the Bill of Rights',
];
const DUE = ['today', 'tomorrow', 'in 2 days', 'in 3 days', 'next week', 'in 2 weeks'];

const promptFixtures = [];
let pid = 0;
const nextId = (prefix) => `${prefix}-${String(pid++).padStart(4, '0')}`;

for (let i = 0; i < 40; i += 1) {
  promptFixtures.push({
    id: nextId('bd'),
    kind: 'breakdown',
    title: `Write a ${ARTIFACTS[i % ARTIFACTS.length]} on ${TOPICS[i % TOPICS.length]}`,
    subject: i % 4 === 0 ? null : SUBJECTS[i % SUBJECTS.length],
    description: i % 3 === 0 ? null : `Use at least ${2 + (i % 4)} sources.`,
    duePhrase: DUE[i % DUE.length],
    sessionMinutes: [15, 20, 25, 30, 45, 60][i % 6],
  });
}

const edgeTitles = [
  '',
  '   ',
  'a',
  '\u{1F600}',
  'Read\t\tthe   chapter',
  'First line\nSecond line\n\nThird',
  '寿司の宿題を終わらせる',
  'Trabajo de español: leer el capítulo 3',
  'Прочитать главу 4',
  'Title with "quotes" and \\backslashes\\',
  'Title with, commas; and: colons',
  'x'.repeat(300),
  'Título con acentos: análisis crítico',
  '  leading and trailing  ',
];
for (const title of edgeTitles) {
  promptFixtures.push({
    id: nextId('edge'),
    kind: 'breakdown',
    title,
    subject: null,
    description: null,
    duePhrase: 'in 3 days',
    sessionMinutes: 30,
  });
}

// every branch of the relative due phrase
for (const days of [-30, -1, 0, 1, 2, 3, 6, 7, 8, 13, 14, 15, 17, 20, 21, 27, 28, 30, 45, 60, 200, 365]) {
  promptFixtures.push({ id: nextId('due'), kind: 'duePhrase', days });
}

for (const text of [
  'Read chapters 4 to 6 by Friday. Lab report due next Tuesday.',
  '',
  '   ',
  'Многострочный\n\nтекст задания',
  'Paragraph one.\n\nParagraph two with a due date of March 3.',
]) {
  promptFixtures.push({ id: nextId('ex'), kind: 'extraction', text });
}
for (const [title, description] of [
  ['Analyze the rhetorical devices in the assigned speech', null],
  ['Evaluate the reliability of the sources', 'Consider bias and date.'],
  ['', null],
  ['寿司の宿題', '説明'],
]) {
  promptFixtures.push({ id: nextId('sm'), kind: 'simplify', title, description });
}
for (const reason of [
  'there were 9 steps, the maximum is 7',
  'step 2 is not a physical action',
  'the starter action does not restate the first step',
]) {
  promptFixtures.push({
    id: nextId('rp'),
    kind: 'repair',
    title: 'Write a 5-paragraph essay on The Great Gatsby',
    subject: 'English 2H',
    description: null,
    duePhrase: 'in 3 days',
    sessionMinutes: 30,
    reason,
  });
}

// validator fixtures

const TASK = {
  title: 'Write a 5-paragraph essay on The Great Gatsby',
  subject: 'English 2H',
  description: null,
};

const validatorFixtures = [];
let vid = 0;
const vNextId = (prefix) => `${prefix}-${String(vid++).padStart(4, '0')}`;

const step = (title, minutes) => ({ title, minutes });
const good = {
  steps: [
    step('Open the assignment sheet and read the prompt out loud', 5),
    step('List the three points the essay has to make', 10),
    step('Write the introduction without stopping to edit', 20),
    step('Write the three body paragraphs', 45),
    step('Read it aloud and fix what sounds wrong', 15),
  ],
  starterAction: 'Open the assignment sheet and read the prompt out loud',
};

function pushBreakdown(prefix, raw) {
  validatorFixtures.push({ id: vNextId(prefix), kind: 'breakdown', raw, task: TASK });
}

// valid JSON, bare and wrapped in the noise a small model adds
pushBreakdown('ok', JSON.stringify(good));
pushBreakdown('ok', JSON.stringify(good, null, 2));
pushBreakdown('ok', '```json\n' + JSON.stringify(good) + '\n```');
pushBreakdown('ok', '```\n' + JSON.stringify(good) + '\n```');
pushBreakdown('ok', "Sure! Here's the breakdown:\n" + JSON.stringify(good));
pushBreakdown('ok', JSON.stringify(good) + '\n\nHope that helps!');
pushBreakdown('ok', '  \n ' + JSON.stringify(good) + ' \n ');
pushBreakdown('ok', 'Here you go: ' + JSON.stringify(good) + ' Let me know {if} you need more.');

for (const raw of [
  '',
  '   ',
  '\n\n',
  'no json at all',
  'I think you should start by planning your essay.',
  '{',
  '}',
  '{"steps":',
  '{"steps":[',
  '{"steps":[{"title":"Open the book","minutes":5}',
  '[1,2,3]',
  '[{"title":"Open the book","minutes":5}]',
  '"a string"',
  '42',
  'null',
  'true',
  '{"steps":[],"starterAction":"Open the book now",}',
  "{'steps':[],'starterAction':'Open the book now'}",
  '{steps:[],starterAction:"Open the book now"}',
  '{"steps":[],"starterAction":"Open the book now",,}',
  '{"steps":[],"starterAction":}',
  '```json\n{"steps":\n```',
  '{"steps":[{"title":"Open the book","minutes":5},]}',
  '{"a":{"b":{"c":1}}}',
  '{"note":"use the {template} file"}',
  '{"note":"she said \\"go\\" first"}',
]) {
  pushBreakdown('bad', raw);
}

// schema violations, one axis at a time
const schemaMutations = [
  ['missing steps', { starterAction: good.starterAction }],
  ['missing starter', { steps: good.steps }],
  ['extra root field', { ...good, confidence: 0.9 }],
  ['extra step field', { ...good, steps: [{ ...good.steps[0], priority: 'high' }, ...good.steps.slice(1)] }],
  ['steps not a list', { ...good, steps: 'three' }],
  ['starter not a string', { ...good, starterAction: 42 }],
  ['starter null', { ...good, starterAction: null }],
  ['step not an object', { ...good, steps: ['open the book', ...good.steps.slice(1)] }],
  ['step title not a string', { ...good, steps: [{ title: 5, minutes: 10 }, ...good.steps.slice(1)] }],
  ['minutes as string', { ...good, steps: [{ title: good.steps[0].title, minutes: '10' }, ...good.steps.slice(1)] }],
  ['minutes fractional', { ...good, steps: [{ title: good.steps[0].title, minutes: 10.5 }, ...good.steps.slice(1)] }],
  ['minutes boolean', { ...good, steps: [{ title: good.steps[0].title, minutes: true }, ...good.steps.slice(1)] }],
  ['minutes null', { ...good, steps: [{ title: good.steps[0].title, minutes: null }, ...good.steps.slice(1)] }],
];
for (const [, obj] of schemaMutations) pushBreakdown('schema', JSON.stringify(obj));

for (const n of [0, 1, 2, 3, 7, 8, 9, 12]) {
  pushBreakdown(
    'count',
    JSON.stringify({
      steps: Array.from({ length: n }, (_, i) => step(`Write paragraph number ${i + 1} of the essay`, 10)),
      starterAction: 'Write paragraph number 1 of the essay',
    }),
  );
}

for (const minutes of [-10, 0, 1, 4, 5, 45, 46, 60, 1000]) {
  pushBreakdown(
    'minutes',
    JSON.stringify({
      steps: [step('Open the assignment sheet and read it', minutes), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: 'Open the assignment sheet and read it',
    }),
  );
}

for (const title of ['', 'a', 'abc', 'abcd', 'x'.repeat(79), 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(200)]) {
  pushBreakdown(
    'title',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: 'Open the assignment sheet and read it',
    }),
  );
}

for (const starter of ['', 'Open', 'Open the', 'Open the sheet', 'x'.repeat(119), 'x'.repeat(120), 'x'.repeat(121)]) {
  pushBreakdown('starter', JSON.stringify({ ...good, starterAction: starter }));
}

// every deny-list phrase, read from the lexicon so the corpus cannot drift from it
const denyList = readFileSync('services/lexicon/vague-verbs.txt', 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));
for (const phrase of denyList) {
  for (const shape of [`${phrase} the assignment now`, `Read the sheet and ${phrase} it`]) {
    pushBreakdown(
      'deny',
      JSON.stringify({
        steps: [step(shape.slice(0, 80), 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
        starterAction: shape.slice(0, 80),
      }),
    );
  }
}

const vagueTitles = [
  'Plan your essay carefully', 'Think about what you want to say', 'Consider the main themes',
  'Decide on your thesis', 'Brainstorm some ideas first', 'Figure out what the prompt wants',
  'Work on the introduction', 'Start on the first paragraph', 'Prepare to write the essay',
  'Get ready to start writing', 'Reflect on the reading', 'Understand the main argument',
  'Read the chapter and think about the themes', 'Write the essay then reflect on it',
  'Draw the planetary orbit diagram', 'Open the plan file on the desktop',
  'Read the chapter about planning permission', 'Write down what the deciding factor was',
];
for (const title of vagueTitles) {
  pushBreakdown(
    'vague',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}

const openers = [
  'Open the assignment sheet and read it', 'Annotate the prompt with your own words',
  'Highlight the three key requirements', 'Your essay needs three points',
  'Maybe look at the rubric first', 'Essay introduction paragraph',
  'The first step is to open the sheet', 'Quickly open the assignment sheet',
  '寿司を食べる', 'Ouvrir le document', 'Reading the chapter carefully',
];
for (const title of openers) {
  pushBreakdown(
    'verb',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}

// hallucinated proper nouns, plus sourced nouns and sentence-initial words that are fine
const hallucinationTitles = [
  'Read the chapter about Gatsby and Daisy Buchanan',
  'Read the Gatsby chapters listed on the sheet',
  'Read the prompt, Then write the three points down',
  'Write the essay for Mr Henderson by Friday',
  'Open the English 2H folder on your laptop',
  'Read the chapter and note what Nick says',
  'Write about the Roaring Twenties setting',
  'Open the file named Draft-1 on the desktop',
];
for (const title of hallucinationTitles) {
  pushBreakdown(
    'halluc',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}

// words() strips the apostrophe ("Ohm's" gives "ohm" and "s"), so the proper-noun
// check must also test the possessive stem
{
  const raw = JSON.stringify({
    steps: [
      step("Open Ohm's law problem set and read the first page", 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: "Open Ohm's law problem set and read the first page",
  });
  validatorFixtures.push({
    id: vNextId('possessive'),
    kind: 'breakdown',
    raw,
    task: { title: "Ohm's law problem set", subject: null, description: null },
  });
}
{
  const raw = JSON.stringify({
    steps: [
      step("Read about Newton's third law before starting", 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: "Read about Newton's third law before starting",
  });
  validatorFixtures.push({
    id: vNextId('possessive'),
    kind: 'breakdown',
    raw,
    task: { title: "Ohm's law problem set", subject: null, description: null },
  });
}

// the curly apostrophe (U+2019) must survive like the straight one, or the
// possessive-stem check never fires
{
  const raw = JSON.stringify({
    steps: [
      step('Open Ohm’s law problem set and read the first page', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Open Ohm’s law problem set and read the first page',
  });
  validatorFixtures.push({
    id: vNextId('curlyapos'),
    kind: 'breakdown',
    raw,
    task: { title: "Ohm's law problem set", subject: null, description: null },
  });
}
{
  const raw = JSON.stringify({
    steps: [
      step('Read Gatsby’s notes before starting', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Read Gatsby’s notes before starting',
  });
  validatorFixtures.push({
    id: vNextId('curlyapos'),
    kind: 'breakdown',
    raw,
    task: { title: 'Write a lab report on cellular respiration', subject: null, description: null },
  });
}

// the stem check needs a real possessive shape, not everything before the first
// apostrophe, or a hallucinated suffix rides along behind a sourced prefix
{
  const raw = JSON.stringify({
    steps: [
      step("Open Ohm'sGatsbyNotes and read the first page", 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: "Open Ohm'sGatsbyNotes and read the first page",
  });
  validatorFixtures.push({
    id: vNextId('posshole'),
    kind: 'breakdown',
    raw,
    task: { title: "Ohm's law problem set", subject: null, description: null },
  });
}
{
  const raw = JSON.stringify({
    steps: [
      step("Open Ohm's law problem set and read the first page", 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: "Open Ohm's law problem set and read the first page",
  });
  validatorFixtures.push({
    id: vNextId('posshole'),
    kind: 'breakdown',
    raw,
    task: { title: "Ohm's law problem set", subject: null, description: null },
  });
}

// a title split on U+00A0 must tokenize the same on both sides
pushBreakdown(
  'nbsp',
  JSON.stringify({
    steps: [
      step('Read the Gatsby chapters now', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Read the Gatsby chapters now',
  }),
);
pushBreakdown(
  'nbsp',
  JSON.stringify({
    steps: [
      step('Read about Daisy Buchanan now', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Read about Daisy Buchanan now',
  }),
);

for (const title of ['Prove the next ten proofs', 'Glaze the bowl and let it dry']) {
  pushBreakdown(
    'verb2',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}

// single-word deny entries only match as the first word, so these pass
for (const title of [
  'Describe the process of photosynthesis',
  'Draw the floor plan for the set',
  'Solve for x to determine the slope',
  'Copy the twenty words you need to learn',
]) {
  pushBreakdown(
    'vaguefix',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}
// and these still fail
for (const title of ['Think about the essay', 'Plan the essay']) {
  pushBreakdown(
    'vaguestill',
    JSON.stringify({
      steps: [step(title, 10), step('Write the essay body paragraphs', 30), step('Read it aloud and fix what sounds wrong', 15)],
      starterAction: title,
    }),
  );
}

// everyday assignment nouns pass unprompted; an invented proper noun still fails
pushBreakdown(
  'common2',
  JSON.stringify({
    steps: [
      step('Open the Google Doc and start typing', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Open the Google Doc and start typing',
  }),
);
{
  const raw = JSON.stringify({
    steps: [
      step('Read the assigned chapter about Gatsby closely', 10),
      step('Write the essay body paragraphs', 30),
      step('Read it aloud and fix what sounds wrong', 15),
    ],
    starterAction: 'Read the assigned chapter about Gatsby closely',
  });
  validatorFixtures.push({
    id: vNextId('common2'),
    kind: 'breakdown',
    raw,
    task: { title: 'Write a reading response', subject: null, description: null },
  });
}

pushBreakdown('dup', JSON.stringify({ steps: [good.steps[0], good.steps[1], good.steps[1]], starterAction: good.starterAction }));
pushBreakdown('dup', JSON.stringify({ steps: [good.steps[0], good.steps[1], { title: good.steps[1].title.toUpperCase() + '.', minutes: 20 }], starterAction: good.starterAction }));
pushBreakdown('total', JSON.stringify({ steps: Array.from({ length: 7 }, (_, i) => step(`Write section number ${i + 1} of the paper`, 45)), starterAction: 'Write section number 1 of the paper' }));
pushBreakdown('total', JSON.stringify({ steps: [step('Open the sheet and read it', 5), step('Write one sentence of the essay', 5), step('Read the sentence back to yourself', 5)], starterAction: 'Open the sheet and read it' }));
pushBreakdown('sim', JSON.stringify({ ...good, starterAction: 'Gather every source you might possibly need' }));
pushBreakdown('sim', JSON.stringify({ ...good, starterAction: 'Open the assignment sheet, then read the prompt' }));

// adversarial task inputs with a valid response
for (const task of [
  { title: '', subject: null, description: null },
  { title: 'a', subject: null, description: null },
  { title: '\u{1F600}', subject: null, description: null },
  { title: 'qx9 '.repeat(125), subject: null, description: null },
  { title: '寿司の宿題', subject: null, description: null },
  { title: 'Sign the permission slip', subject: null, description: null },
  { title: 'this damn essay on The Great Gatsby', subject: 'English', description: null },
]) {
  validatorFixtures.push({ id: vNextId('advtask'), kind: 'breakdown', raw: JSON.stringify(good), task });
}

for (const raw of [
  '{"tasks":[]}',
  '{"tasks":[{"title":"Read chapters 4 to 6","dueInDays":3,"subject":"English"}]}',
  '{"tasks":[{"title":"Read it","dueInDays":0}]}',
  '{"tasks":[{"title":"Read it","dueInDays":365}]}',
  '{"tasks":[{"title":"Read it","dueInDays":-1}]}',
  '{"tasks":[{"title":"Read it","dueInDays":400}]}',
  '{"tasks":[{"title":"Read it","dueInDays":1.5}]}',
  '{"tasks":[{"title":"Read it","dueInDays":true}]}',
  '{"tasks":[{"title":"ab","dueInDays":1}]}',
  '{"tasks":[{"title":"' + 'x'.repeat(101) + '","dueInDays":1}]}',
  '{"tasks":[{"title":"Read it","dueInDays":1,"subject":"' + 'x'.repeat(41) + '"}]}',
  '{"tasks":[{"title":"Read it","dueInDays":1,"priority":1}]}',
  '{"tasks":[{"title":"Read it"}]}',
  '{"tasks":' + JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ title: `Task number ${i}`, dueInDays: 1 }))) + '}',
  '{"tasks":"none"}',
  '{}',
  '{"items":[]}',
  '```json\n{"tasks":[]}\n```',
]) {
  validatorFixtures.push({ id: vNextId('extr'), kind: 'extraction', raw, task: null });
}

const simplifyTask = { title: 'Analyze the rhetorical devices in the assigned speech', description: null };
for (const raw of [
  '{"title":"Find the persuasion tricks","explanation":"Read the speech and mark where the speaker tries to convince you of something."}',
  '{"title":"Find the tricks","explanation":"Too short"}',
  '{"title":"ab","explanation":"Read the speech and mark where the speaker tries to convince you."}',
  '{"title":"Find the persuasion tricks in the Gettysburg speech","explanation":"Read the speech and mark where the speaker tries to convince you."}',
  '{"title":"Find the tricks"}',
  '{"explanation":"Read the speech and mark where the speaker tries to convince you."}',
  '{"title":42,"explanation":"Read the speech and mark where the speaker tries to convince you."}',
  '{"title":"Find the tricks","explanation":"' + 'word '.repeat(120) + '"}',
  '{"title":"Find the tricks","explanation":"Read the speech carefully now.","extra":1}',
]) {
  validatorFixtures.push({ id: vNextId('simp'), kind: 'simplification', raw, task: simplifyTask });
}

writeFileSync('__tests__/fixtures/prompt-parity.json', JSON.stringify(promptFixtures, null, 2) + '\n', 'utf8');
writeFileSync('__tests__/fixtures/validator-parity.json', JSON.stringify(validatorFixtures, null, 2) + '\n', 'utf8');

console.log(`prompt fixtures:    ${promptFixtures.length} (gate requires >= 50)`);
console.log(`validator fixtures: ${validatorFixtures.length} (gate requires >= 200)`);
