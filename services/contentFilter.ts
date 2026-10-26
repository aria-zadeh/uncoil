// filter for model output, plus prompt input sanitization. users are mostly minors and a small model can
// still say anything, so a failure falls back to the template and is never repaired, logged or shown.
// whole-token matching (the scunthorpe problem) except SUBSTRING_ROOTS. a filter has to name what it
// blocks, hence this file's 'medical' exemption in scripts/verify/scan-scope.mjs

export type FilterCategory =
  | 'always'
  | 'harm'
  | 'contextual'
  | 'medical'
  | 'link'
  | 'contact'
  | 'token';

export type FilterResult = { ok: true } | { ok: false; category: FilterCategory };

// every added_tokens entry in tokenizer.rnejson. contentFilter.test.ts fails if this drifts
export const SPECIAL_TOKENS: readonly string[] = [
  '<|endoftext|>',
  '<|im_start|>',
  '<|im_end|>',
  '<repo_name>',
  '<reponame>',
  '<file_sep>',
  '<filename>',
  '<gh_stars>',
  '<issue_start>',
  '<issue_comment>',
  '<issue_closed>',
  '<jupyter_start>',
  '<jupyter_text>',
  '<jupyter_code>',
  '<jupyter_output>',
  '<jupyter_script>',
  '<empty_output>',
];

// catches control-token shapes a future tokenizer might add
const TOKEN_SHAPES: readonly RegExp[] = [/<\|[a-z_]{2,30}\|>/i, /<jupyter_[a-z_]*>/i];

// links and contact details run on the raw text, before leet mapping
const LINK_PATTERNS: readonly RegExp[] = [
  /\b(?:https?|ftp):\/\//i,
  /\bwww\.[a-z0-9-]/i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|edu|gov|info|biz|me|ly|app|dev|xyz|gg|tv|us|uk|ca)\b/i,
];

const CONTACT_PATTERNS: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i,
  // north-american shape, or 10+ digits broken only by phone separators. no lookbehind, not every
  // js engine the app runs on has it
  /(?:^|[^\d])(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/,
];

// inflections listed, not stemmed, so "assess" never reaches "ass" and "Dickens" never reaches "dick"
const ALWAYS_WORDS: readonly string[] = [
  // profanity
  'shit', 'shits', 'shitty', 'shitting', 'shitted', 'shithead', 'shitheads', 'bullshit', 'horseshit',
  'bitch', 'bitches', 'bitching', 'bitchy',
  'bastard', 'bastards',
  'asshole', 'assholes', 'arsehole', 'arseholes', 'dumbass', 'jackass', 'asshat', 'smartass',
  'piss', 'pissed', 'pissing',
  'bollocks', 'wanker', 'wankers', 'wank', 'wanking', 'twat', 'twats',
  'goddamn', 'goddamnit',
  // sexual / explicit
  'dildo', 'dildos', 'blowjob', 'blowjobs', 'handjob', 'handjobs', 'cumshot', 'jizz',
  'orgasm', 'orgasms', 'horny', 'slut', 'sluts', 'slutty', 'whore', 'whores',
  'titties', 'boobs', 'boobies', 'clit', 'clitoris', 'masturbate', 'masturbating', 'masturbation',
  'hentai', 'milf', 'nsfw', 'bdsm', 'threesome', 'cameltoe',
  // racial and ethnic slurs
  'nigga', 'niggas', 'niggaz', 'chink', 'chinks', 'gook', 'gooks', 'spic', 'spics', 'spick',
  'kike', 'kikes', 'wetback', 'wetbacks', 'beaner', 'beaners', 'coon', 'coons',
  'towelhead', 'towelheads', 'raghead', 'ragheads', 'paki', 'pakis', 'jap', 'japs',
  'wop', 'wops', 'dago', 'dagos', 'injun', 'redskin', 'redskins', 'squaw', 'zipperhead',
  'honky', 'honkies', 'kraut', 'krauts', 'chinaman',
  // homophobic and transphobic slurs
  'fag', 'fags', 'faggy', 'dyke', 'dykes', 'poof', 'poofs', 'poofter', 'tranny', 'trannies',
  'shemale', 'shemales',
  // ableist slurs
  'retard', 'retards', 'retarded', 'tard', 'tards', 'spaz', 'spazz', 'mong', 'mongs',
];

// roots matched anywhere inside a token, for compounds and inflections. safe because almost no real word
// contains them, and `unless` strips the ones that do (scunthorpe, snigger) first
const SUBSTRING_ROOTS: readonly { root: string; unless: readonly string[] }[] = [
  { root: 'fuck', unless: [] },
  { root: 'cunt', unless: ['scunthorp'] },
  { root: 'nigger', unless: ['snigger'] },
  { root: 'faggot', unless: [] },
];

// masked spellings ("f*ck"), checked before punctuation is dropped. only shapes where the hidden letters
// can't be anything innocent
const WILDCARD_PATTERNS: readonly RegExp[] = [
  /\bf[*#]+c?k/,
  /\bf[*#]{2,}(?:ing|in|ed|er)\b/,
  /\bfu[*#]+c?k/,
  /\bfuc[*#]/,
  /\bsh[*#]+t\b/,
  /\bs[*#]{2,}t\b/,
  /\bb[*#]+tch/,
  /\bbi[*#]+ch/,
  /\bc[*#]+nt/,
  /\bn[*#]+gg/,
  /\bni[*#]+(?:er|a)\b/,
  /\ba[*#]+hole/,
  /\bf[*#]+g(?:got)?\b/,
];

// normalized, single-spaced, matched on whole tokens
const HARM_PHRASES: readonly string[] = [
  'kill yourself', 'kill urself', 'kill your self', 'kill ur self', 'kys',
  'end your life', 'end ur life', 'end it all', 'take your own life', 'take your life',
  'hurt yourself', 'harm yourself', 'cut yourself', 'cut your wrists', 'slit your wrists',
  'hang yourself', 'shoot yourself', 'stab yourself', 'starve yourself', 'drown yourself',
  'unalive yourself', 'jump off a bridge', 'jump off a building', 'drink bleach',
  'you should die', 'you should just die', 'you deserve to die', 'go die', 'just die',
  'die in a fire', 'nobody would miss you', 'no one would miss you', 'better off dead',
  'kill them all', 'shoot up the school', 'shoot up your school', 'bring a gun to school',
];

// fine in schoolwork but not unprompted. any form in the user's input allows the whole group, so an
// essay about "killing" may get a step that says "kill"
const CONTEXTUAL_GROUPS: readonly (readonly string[])[] = [
  ['suicide', 'suicides', 'suicidal'],
  ['kill', 'kills', 'killed', 'killing', 'killings', 'killer', 'killers'],
  ['murder', 'murders', 'murdered', 'murdering', 'murderer', 'murderers'],
  ['rape', 'raped', 'rapes', 'raping', 'rapist', 'rapists'],
  ['gun', 'guns', 'gunfire', 'gunman'],
  // bare 'shoot' is ordinary in photography, film and pe steps
  ['shootings', 'shooter'],
  ['bomb', 'bombs', 'bombed', 'bombing', 'bombings'],
  ['weapon', 'weapons'],
  ['stab', 'stabs', 'stabbed', 'stabbing'],
  ['terrorist', 'terrorists', 'terrorism'],
  ['kidnap', 'kidnapped', 'kidnapping'],
  ['drug', 'drugs'],
  ['cocaine', 'heroin', 'meth', 'weed', 'marijuana', 'cannabis', 'opioid', 'opioids', 'fentanyl'],
  ['alcohol', 'drunk', 'vodka', 'beer', 'whiskey'],
  ['porn', 'porno', 'pornography', 'pornographic'],
  ['nude', 'nudes', 'nudity', 'naked'],
  ['sex', 'sexual', 'sexually', 'sexy', 'sexting'],
  ['penis', 'penises'],
  ['vagina', 'vaginas'],
  ['anal', 'anus'],
  ['ass', 'arse'],
  ['dick', 'dicks'],
  ['cock', 'cocks'],
  ['pussy'],
  ['tits', 'tit'],
  ['cum'],
  ['prick', 'pricks'],
  ['homo'],
  ['pedophile', 'pedophiles', 'paedophile', 'pedo', 'pedophilia'],
  ['damn', 'damned'],
  ['hell'],
];

// same rule as contextual. the app makes no medical claims, so the model can't introduce them either
const MEDICAL_GROUPS: readonly (readonly string[])[] = [
  ['adhd'],
  ['meds', 'medication', 'medications', 'medicate', 'medicated'],
  ['medicine', 'medicines'],
  ['pill', 'pills'],
  ['dose', 'doses', 'dosage', 'dosing', 'overdose'],
  ['diagnose', 'diagnosed', 'diagnoses', 'diagnosis', 'diagnosing'],
  ['cure', 'cures', 'cured', 'curing'],
  ['therapy', 'therapies', 'therapist', 'therapists'],
  ['doctor', 'doctors'],
  ['prescription', 'prescriptions', 'prescribe', 'prescribed'],
  ['anxiety'],
  // 'depression' is left out, the great depression is a standard history unit
  ['depressed'],
];

// counts only, the terms themselves are never exported
export const FILTER_TERM_COUNTS = {
  always: ALWAYS_WORDS.length + SUBSTRING_ROOTS.length + WILDCARD_PATTERNS.length,
  harm: HARM_PHRASES.length,
  contextual: CONTEXTUAL_GROUPS.reduce((n, g) => n + g.length, 0),
  medical: MEDICAL_GROUPS.reduce((n, g) => n + g.length, 0),
} as const;

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

// only runs that already hold a letter: "sh1t" is a word in disguise, "455" is a page number.
// a trailing "!" is punctuation, not an "i"
function leetRun(run: string): string {
  if (!/[a-z]/.test(run)) return run;
  const body = run.replace(/!+$/, '');
  let mapped = '';
  for (const ch of body) mapped += LEET[ch] ?? ch;
  return mapped + ' '.repeat(run.length - body.length);
}

function leetMap(folded: string): string {
  return folded.replace(/[a-z0-9@$!*#]+/g, leetRun);
}

// punctuation other than leet characters is kept so the wildcard patterns can still see it
export function normalize(text: string): string {
  return leetMap(fold(text)).replace(/([a-z])\1{2,}/g, '$1$1');
}

function tokensOf(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter((t) => t !== '');
}

// joins runs of single letters so "f u c k" and "f.u.c.k" read as the word they spell
function joinSpelledOut(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    if (run.length >= 2) out.push(run);
    else if (run.length === 1) out.push(run);
    run = '';
  };
  for (const t of tokens) {
    if (t.length === 1) run += t;
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

// only applied to elongated tokens, so "Bob" or "as" never fold onto a listed term
function dedupe(token: string): string {
  return token.replace(/([a-z])\1+/g, '$1');
}

const ALWAYS_SET = new Set(ALWAYS_WORDS);
const ALWAYS_DEDUPED = new Set(ALWAYS_WORDS.map(dedupe));
const HARM_PADDED = HARM_PHRASES.map((p) => ` ${p} `);

function groupIndex(groups: readonly (readonly string[])[]): Map<string, number> {
  const index = new Map<string, number>();
  groups.forEach((group, i) => group.forEach((form) => index.set(form, i)));
  return index;
}

const CONTEXTUAL_INDEX = groupIndex(CONTEXTUAL_GROUPS);
const MEDICAL_INDEX = groupIndex(MEDICAL_GROUPS);

function rootIn(token: string, root: string, unless: readonly string[]): boolean {
  if (!token.includes(root)) return false;
  let stripped = token;
  for (const word of unless) stripped = stripped.split(word).join('');
  return stripped.includes(root);
}

// roots without a double letter are also checked with doubles folded ("fuuck"). roots with one aren't,
// their folded forms are innocent words ("Niger")
function hasSubstringRoot(token: string): boolean {
  const folded = dedupe(token);
  for (const { root, unless } of SUBSTRING_ROOTS) {
    if (rootIn(token, root, unless)) return true;
    if (dedupe(root) === root && folded !== token && rootIn(folded, root, unless)) return true;
  }
  return false;
}

function isAlwaysToken(token: string, elongated: boolean): boolean {
  if (ALWAYS_SET.has(token) || hasSubstringRoot(token)) return true;
  if (elongated) {
    const d = dedupe(token);
    if (ALWAYS_DEDUPED.has(d) || hasSubstringRoot(d)) return true;
  }
  return false;
}

interface Analysed {
  // plain, and with spelled-out runs joined
  sequences: string[][];
  normalized: string;
  // tokens that had a 3+ letter run in the raw text
  elongated: Set<string>;
}

function analyse(text: string): Analysed {
  const mapped = leetMap(fold(text));
  const normalized = mapped.replace(/([a-z])\1{2,}/g, '$1$1');
  const plain = tokensOf(normalized);
  const joined = joinSpelledOut(plain);
  // collapsing runs never moves a token boundary, so these line up one-for-one with plain
  const elongated = new Set<string>();
  tokensOf(mapped).forEach((t, i) => {
    if (t !== plain[i]) elongated.add(plain[i]);
  });
  return { sequences: [plain, joined], normalized, elongated };
}

function contextGroups(context: string): { contextual: Set<number>; medical: Set<number> } {
  const contextual = new Set<number>();
  const medical = new Set<number>();
  const { sequences } = analyse(context);
  for (const seq of sequences) {
    for (const t of seq) {
      const c = CONTEXTUAL_INDEX.get(t);
      if (c !== undefined) contextual.add(c);
      const m = MEDICAL_INDEX.get(t);
      if (m !== undefined) medical.add(m);
    }
  }
  return { contextual, medical };
}

function scanSevere(a: Analysed): FilterCategory | null {
  for (const seq of a.sequences) {
    for (const t of seq) {
      if (isAlwaysToken(t, a.elongated.has(t))) return 'always';
    }
  }
  if (WILDCARD_PATTERNS.some((re) => re.test(a.normalized))) return 'always';
  for (const seq of a.sequences) {
    const padded = ` ${seq.join(' ')} `;
    if (HARM_PADDED.some((p) => padded.includes(p))) return 'harm';
  }
  return null;
}

// context is the user's own text, which licenses contextual and medical words they wrote. only the
// category comes back: a blocked word must never be echoed into the ui, a log or a repair prompt
export function checkText(text: string, context: string): FilterResult {
  if (text === '') return { ok: true };

  if (SPECIAL_TOKENS.some((tok) => text.includes(tok)) || TOKEN_SHAPES.some((re) => re.test(text))) {
    return { ok: false, category: 'token' };
  }
  if (CONTACT_PATTERNS.some((re) => re.test(text))) return { ok: false, category: 'contact' };
  if (LINK_PATTERNS.some((re) => re.test(text))) return { ok: false, category: 'link' };

  const a = analyse(text);
  const severe = scanSevere(a);
  if (severe !== null) return { ok: false, category: severe };

  let allowed: ReturnType<typeof contextGroups> | null = null;
  for (const seq of a.sequences) {
    for (const t of seq) {
      const c = CONTEXTUAL_INDEX.get(t);
      const m = MEDICAL_INDEX.get(t);
      if (c === undefined && m === undefined) continue;
      allowed ??= contextGroups(context);
      if (c !== undefined && !allowed.contextual.has(c)) return { ok: false, category: 'contextual' };
      if (m !== undefined && !allowed.medical.has(m)) return { ok: false, category: 'medical' };
    }
  }
  return { ok: true };
}

export function isSafe(text: string, context: string): boolean {
  return checkText(text, context).ok;
}

export function allSafe(texts: readonly string[], context: string): boolean {
  return texts.every((t) => isSafe(t, context));
}

// pre-screen for user input. the pipeline skips the model for it, a model shown that text would likely
// echo it. contextual and medical words don't count, allowing them is the point of the contextual rule
export function isInputBlocked(text: string): boolean {
  if (text === '') return false;
  return scanSevere(analyse(text)) !== null;
}

// c0/c1 controls except tab and newline, bidi controls, zero-width characters and the bom
const STRIP_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩​-‏﻿]/g;

// loops until stable, so "<|im_<|im_end|>end|>" can't reassemble a token and removing a zero-width
// character can't reveal one
export function sanitizeForPrompt(text: string): string {
  let current = text;
  for (;;) {
    let next = current.replace(STRIP_CHARS, '');
    for (const tok of SPECIAL_TOKENS) next = next.split(tok).join('');
    if (next === current) return current;
    current = next;
  }
}
