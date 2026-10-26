// due-date resolution for extracted tasks. the model finds tasks well but miscounts weekdays (0.442 exact
// on the held-out eval, nearly all misses off by one day), so due phrases in the text are re-resolved here.
// train/due_dates.py is the twin, and both must pass __tests__/fixtures/due-phrases.json and due-reconcile.json
import { STOPWORDS } from "@/services/lexicon.generated";
import { daysUntil, WEEKDAYS, type Weekday } from "@/services/prompt";
import { EXTRACTION_LIMITS, type ExtractedTask } from "@/types";

// same word splitting as validation.ts, so both agree on what a word is
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
}

// "due" is in nearly every sentence, so as a content word it would match sentences to anything
const RECONCILE_STOPWORDS = new Set<string>([...STOPWORDS, "due"]);

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => !RECONCILE_STOPWORDS.has(w)));
}

// indexed like WEEKDAYS (monday 0) so every rule shares prompt.ts's arithmetic
const WEEKDAY_INDEX: Record<string, number> = {
  monday: 0,
  mon: 0,
  tuesday: 1,
  tue: 1,
  tues: 1,
  wednesday: 2,
  wed: 2,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  friday: 4,
  fri: 4,
  saturday: 5,
  sat: 5,
  sunday: 6,
  sun: 6,
};

// the optional "." goes on each abbreviation. a group-level \.? would swallow the period in "next Tuesday."
const WD_ALT = Object.keys(WEEKDAY_INDEX)
  .map((name) => (name.length < 6 ? `${name}\\.?` : name))
  .join("|");
const WD_GROUP = `(${WD_ALT})`;

function weekdayIndex(token: string): number | null {
  const clean = token.trim().toLowerCase().replace(/\.$/, "");
  return clean in WEEKDAY_INDEX ? WEEKDAY_INDEX[clean] : null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
  "twenty-five": 25,
  "twenty-six": 26,
  "twenty-seven": 27,
  "twenty-eight": 28,
  "twenty-nine": 29,
  thirty: 30,
};

const NUM_ALT = Object.keys(NUMBER_WORDS).join("|");

// leading filler, possibly chained ("is due this friday"). no rule's required words are in here, so
// backtracking always leaves the real phrase intact
const FILLER_ALT = "due|by|on|is|are|this|for|until|before|the";
const FILLER_RUN = `(?:(?:${FILLER_ALT})[,:]?\\s+)*`;

function parseAmount(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (t === "a" || t === "an") return 1;
  if (/^\d+$/.test(t)) return Number(t);
  return t in NUMBER_WORDS ? NUMBER_WORDS[t] : null;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_ALT = Object.keys(MONTH_INDEX).join("|");

// the calendar half of "Friday the 25th", "Friday, September 12", "Fri 10/30". shared by resolveDuePhrase
// and PHRASE_SOURCES so the combined phrase is found as one match
const CALENDAR_TAIL_SRC = `the\\s+\\d{1,2}(?:st|nd|rd|th)|(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?`;

const FRIDAY = 4;
const MONDAY = 0;

// strictly forward from today. landing on today depends on context: "Monday: quiz" read on a monday is
// today, but "project Monday" later in a chronological list is next week. lastDue tells them apart
function bareWeekdayCount(
  w: number,
  t: number,
  lastDue: number | null,
): number {
  const d = (w - t + 7) % 7;
  if (d === 0) return lastDue === null || lastDue === 0 ? 0 : 7;
  return d;
}

// a bare weekday inside "week one ... week two" blocks is positional, that weekday in the Nth week of the
// run. the base week is this one monday to thursday and the coming one friday to sunday, since a syllabus
// read late in the week is for next week. offset is weeks past the base block
function weekBlockCount(w: number, t: number, offset: number): number {
  const baseMonday = t <= 3 ? -t : 7 - t;
  const d = baseMonday + 7 * offset + w;
  return d < 0 ? d + 7 : d;
}

// always next calendar week, never today. bumped another week if it would land before lastDue, since a
// due list reads chronologically
function nextWeekdayCount(
  w: number,
  t: number,
  lastDue: number | null,
): number {
  const naive = 7 - t + w;
  return lastDue !== null && naive < lastDue ? naive + 7 : naive;
}

// the first such weekday after the last resolved due day, not after today ("lab due friday ... proposal
// due the following monday")
function followingWeekdayCount(
  w: number,
  t: number,
  lastDue: number | null,
): number {
  const base = lastDue ?? 0;
  const baseWeekday = (t + base) % 7;
  const forward = (w - baseWeekday + 7) % 7;
  const d = forward === 0 ? 7 : forward;
  return base + d;
}

function resolveCalendarDate(norm: string, todayDate: Date): number | null {
  const todayYear = todayDate.getFullYear();
  const todayMonth = todayDate.getMonth();
  const todayDay = todayDate.getDate();
  const todayMidnight = new Date(todayYear, todayMonth, todayDay);

  // april 31 must be null, not rolled forward the way Date normalises it. modulo 12 so a deliberate year
  // roll (month 12 as next january) still passes
  const isRequestedDate = (
    candidate: Date,
    monthIndex: number,
    day: number,
  ): boolean =>
    candidate.getMonth() === ((monthIndex % 12) + 12) % 12 &&
    candidate.getDate() === day;

  const finish = (
    monthIndex: number,
    day: number,
    year?: number,
  ): number | null => {
    let candidate = new Date(year ?? todayYear, monthIndex, day);
    if (!isRequestedDate(candidate, monthIndex, day)) return null;
    if (year === undefined && candidate < todayMidnight) {
      candidate = new Date(todayYear + 1, monthIndex, day);
      if (!isRequestedDate(candidate, monthIndex, day)) return null;
    }
    const diff = daysUntil(candidate, todayDate);
    return diff >= 0 ? diff : null;
  };

  let m = norm.match(
    new RegExp(
      `^(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?$`,
    ),
  );
  if (m) {
    const monthIndex = MONTH_INDEX[m[1]];
    const day = Number(m[2]);
    return finish(monthIndex, day, m[3] ? Number(m[3]) : undefined);
  }

  m = norm.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const monthIndex = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
    const year = m[3]
      ? m[3].length === 2
        ? 2000 + Number(m[3])
        : Number(m[3])
      : undefined;
    return finish(monthIndex, day, year);
  }

  m = norm.match(/^(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)$/);
  if (m) {
    const day = Number(m[1]);
    const monthIndex = day >= todayDay ? todayMonth : todayMonth + 1;
    return finish(monthIndex, day, todayYear);
  }

  return null;
}

/** one located due phrase to a day count, or null. calendar phrases need todayDate */
// lastDue is the previous resolved count from the same text, since phrases in a list refer to each other
export function resolveDuePhrase(
  phrase: string,
  today: Weekday,
  lastDue: number | null,
  todayDate?: Date,
  weekOffset: number | null = null,
): number | null {
  const norm = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm === "") return null;

  if (
    new RegExp(
      `^${FILLER_RUN}(?:today|tonight|by the end of class|end of class|before you leave)$`,
    ).test(norm)
  ) {
    return 0;
  }
  if (new RegExp(`^${FILLER_RUN}the day after tomorrow$`).test(norm)) return 2;
  if (new RegExp(`^${FILLER_RUN}tomorrow$`).test(norm)) return 1;

  // counted from today regardless of lastDue
  let m = norm.match(
    new RegExp(`^${FILLER_RUN}(\\d+|${NUM_ALT}) days? from (today|tomorrow)$`),
  );
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return m[2] === "tomorrow" ? n + 1 : n;
  }
  m = norm.match(
    new RegExp(`^${FILLER_RUN}(\\d+|${NUM_ALT}) weeks? from (today|tomorrow)$`),
  );
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return m[2] === "tomorrow" ? n * 7 + 1 : n * 7;
  }

  // counted from the last resolved due day, or from today if there isn't one
  m = norm.match(
    new RegExp(
      `^${FILLER_RUN}(a|an|\\d+|${NUM_ALT}) days? (?:after that|after|later)$`,
    ),
  );
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return (lastDue ?? 0) + n;
  }
  m = norm.match(
    new RegExp(
      `^${FILLER_RUN}(a|an|\\d+|${NUM_ALT}) weeks? (?:after that|after|later)$`,
    ),
  );
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return (lastDue ?? 0) + 7 * n;
  }

  m = norm.match(new RegExp(`^${FILLER_RUN}in (\\d+|${NUM_ALT}) days?$`));
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return n;
  }

  m = norm.match(new RegExp(`^${FILLER_RUN}in (a|an|\\d+|${NUM_ALT}) weeks?$`));
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return n * 7;
  }
  if (new RegExp(`^${FILLER_RUN}next week$`).test(norm)) return 7;
  if (
    new RegExp(`^${FILLER_RUN}(?:the following week|the week after)$`).test(
      norm,
    )
  ) {
    return (lastDue ?? 0) + 7;
  }

  m = norm.match(
    new RegExp(`^${FILLER_RUN}in (a|an|\\d+|${NUM_ALT}) months?$`),
  );
  if (m) {
    const n = parseAmount(m[1]);
    if (n !== null) return n * 30;
  }
  if (new RegExp(`^${FILLER_RUN}end of the month$`).test(norm)) return 30;

  const t = WEEKDAYS.indexOf(today);

  m = norm.match(new RegExp(`^${FILLER_RUN}next ${WD_GROUP}$`));
  if (m) {
    const w = weekdayIndex(m[1]);
    if (w !== null) return nextWeekdayCount(w, t, lastDue);
  }
  m =
    norm.match(new RegExp(`^${FILLER_RUN}${WD_GROUP} of next week$`)) ??
    norm.match(new RegExp(`^${FILLER_RUN}${WD_GROUP} next week$`));
  if (m) {
    const w = weekdayIndex(m[1]);
    if (w !== null) return nextWeekdayCount(w, t, lastDue);
  }
  m = norm.match(new RegExp(`^${FILLER_RUN}${WD_GROUP} after next$`));
  if (m) {
    const w = weekdayIndex(m[1]);
    if (w !== null) return nextWeekdayCount(w, t, lastDue) + 7;
  }

  m =
    norm.match(new RegExp(`^${FILLER_RUN}the following ${WD_GROUP}$`)) ??
    norm.match(new RegExp(`^${FILLER_RUN}the ${WD_GROUP} after that$`)) ??
    norm.match(new RegExp(`^${FILLER_RUN}the ${WD_GROUP} after$`));
  if (m) {
    const w = weekdayIndex(m[1]);
    if (w !== null) return followingWeekdayCount(w, t, lastDue);
  }

  m = norm.match(
    new RegExp(`^${FILLER_RUN}(\\d+|${NUM_ALT}) weeks? from ${WD_GROUP}$`),
  );
  if (m) {
    const n = parseAmount(m[1]);
    const w = weekdayIndex(m[2]);
    if (n !== null && w !== null)
      return bareWeekdayCount(w, t, lastDue) + 7 * n;
  }

  if (
    new RegExp(`^${FILLER_RUN}(?:over the weekend|after the weekend)$`).test(
      norm,
    )
  ) {
    return bareWeekdayCount(MONDAY, t, lastDue);
  }
  if (
    new RegExp(
      `^${FILLER_RUN}(?:end of the week|by the end of the week|this week|due this week|end of week)$`,
    ).test(norm)
  ) {
    return bareWeekdayCount(FRIDAY, t, lastDue);
  }

  m = norm.match(new RegExp(`^${FILLER_RUN}${WD_GROUP}$`));
  if (m) {
    const w = weekdayIndex(m[1]);
    if (w !== null) {
      // positional inside a numbered week block, otherwise the next occurrence after today
      return weekOffset === null
        ? bareWeekdayCount(w, t, lastDue)
        : weekBlockCount(w, t, weekOffset);
    }
  }

  // weekday plus calendar date is one phrase. the date wins when todayDate is known, otherwise the weekday
  // alone. "next Monday, October 19" works the same way
  m = norm.match(
    new RegExp(
      `^${FILLER_RUN}(next\\s+)?${WD_GROUP}\\s*,?\\s*(${CALENDAR_TAIL_SRC})$`,
    ),
  );
  if (m) {
    const w = weekdayIndex(m[2]);
    if (w !== null) {
      if (todayDate) {
        const resolved = resolveCalendarDate(m[3], todayDate);
        if (resolved !== null) return resolved;
      } else {
        return m[1]
          ? nextWeekdayCount(w, t, lastDue)
          : bareWeekdayCount(w, t, lastDue);
      }
    }
  }

  if (todayDate) {
    const resolved = resolveCalendarDate(norm, todayDate);
    if (resolved !== null) return resolved;
  }

  return null;
}

// no letter or digit on either side, so a pattern never matches inside a longer word or number
const LB = "(?<![\\p{L}\\p{N}])";
const LA = "(?![\\p{L}\\p{N}])";

// every phrase shape resolveDuePhrase knows, findable inside a sentence. the scan prefers the longest match
// at the earliest position, so "next Tuesday" beats "Tuesday"
const PHRASE_SOURCES: string[] = [
  "the day after tomorrow",
  "tomorrow",
  "today",
  "tonight",
  "by the end of class",
  "end of class",
  "before you leave",
  `in (?:\\d+|${NUM_ALT}) days?`,
  `in (?:a|an|\\d+|${NUM_ALT}) weeks?`,
  `in (?:a|an|\\d+|${NUM_ALT}) months?`,
  "end of the month",
  "next week",
  "the following week",
  "the week after",
  `next ${WD_GROUP}`,
  `${WD_GROUP} of next week`,
  `${WD_GROUP} next week`,
  `${WD_GROUP} after next`,
  `the following ${WD_GROUP}`,
  `the ${WD_GROUP} after that`,
  `the ${WD_GROUP} after`,
  `(?:\\d+|${NUM_ALT}) weeks? from ${WD_GROUP}`,
  `(?:\\d+|${NUM_ALT}) (?:days?|weeks?) from (?:today|tomorrow)`,
  `(?:a|an|\\d+|${NUM_ALT}) (?:days?|weeks?) (?:after that|after|later)`,
  "over the weekend",
  "after the weekend",
  "end of the week",
  "by the end of the week",
  "this week",
  "due this week",
  "end of week",
  // longer than the bare weekday at the same start, so it wins the scan. takes the same on/by/this lead
  // (plus next), or "on Monday, October 19" would start earlier as "on Monday" and win
  `(?:on |by |this |next )?${WD_GROUP}\\s*,?\\s*(?:${CALENDAR_TAIL_SRC})`,
  `(?:on |by |this )?${WD_GROUP}`,
  `(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?`,
  "\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?",
  "on\\s+the\\s+\\d{1,2}(?:st|nd|rd|th)",
  "the\\s+\\d{1,2}(?:st|nd|rd|th)",
];

const PHRASE_PATTERNS: RegExp[] = PHRASE_SOURCES.map(
  (src) => new RegExp(`${LB}${src}${LA}`, "giu"),
);

// in order of appearance, longest match wins at a position. a leading label ("Monday: quiz") is just the
// bare-weekday pattern, position isn't special
export function findDuePhrases(
  sentence: string,
): { phrase: string; index: number }[] {
  const candidates: { phrase: string; index: number; end: number }[] = [];
  for (const re of PHRASE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      candidates.push({
        phrase: m[0],
        index: m.index,
        end: m.index + m[0].length,
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  // leftmost first, longest first at the same position
  candidates.sort(
    (a, b) => a.index - b.index || b.end - b.index - (a.end - a.index),
  );

  const result: { phrase: string; index: number }[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.index < cursor) continue; // overlaps an already-accepted, longer match
    result.push({ phrase: c.phrase, index: c.index });
    cursor = c.end;
  }
  return result;
}

// "week one" / "week 2" headers. one through twelve only, so "this week a quiz" and "in two weeks" never count
const WEEK_MARKER_RE = new RegExp(
  `${LB}week\\s+(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)${LA}`,
  "giu",
);

const NEXT_WEEK_HEADER_RE = new RegExp(`${LB}next\\s+week${LA}`, "iu");

export function findWeekMarkers(
  sentence: string,
): { index: number; week: number }[] {
  const out: { index: number; week: number }[] = [];
  WEEK_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEEK_MARKER_RE.exec(sentence)) !== null) {
    const week = parseAmount(m[1]);
    if (week !== null && week >= 1 && week <= 12)
      out.push({ index: m.index, week });
  }
  return out;
}

// splits on sentence ends, ";", newlines and a spaced dash, which separates items just like a sentence end.
// "Mon - 6.1 practice due." yields a label sentence "Mon" that reconcileDueDates picks up later
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+|;\s*| - | – | — /)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

function firstOccurrence(sentence: string, tokens: Set<string>): number {
  let min = Infinity;
  for (const token of tokens) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${token}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    const m = re.exec(sentence);
    if (m && m.index < min) min = m.index;
  }
  return min === Infinity ? 0 : min;
}

interface TaskContext {
  sentenceIndex: number | null;
  // where the title's first overlapping word sits in the sentence
  anchor: number;
  // phrases at or past this belong to a later task in the same sentence
  zoneEnd: number;
}

// tasks sharing a sentence get zones between their title words, so a phrase goes to the task it follows,
// not the first task in the sentence
function assignContexts(
  tasks: readonly ExtractedTask[],
  sentences: string[],
): TaskContext[] {
  const sentenceWords = sentences.map(contentWords);
  const claimed = new Set<number>();
  const raw: { sentenceIndex: number | null; anchor: number }[] = [];

  for (const task of tasks) {
    const titleWords = contentWords(task.title);
    const requiredOverlap = titleWords.size <= 2 ? 1 : 2;

    let bestScore = 0;
    let bestIndices: number[] = [];
    let bestOverlap: Set<string> = new Set();
    for (let i = 0; i < sentences.length; i += 1) {
      let overlap = 0;
      const shared = new Set<string>();
      for (const w of titleWords) {
        if (sentenceWords[i].has(w)) {
          overlap += 1;
          shared.add(w);
        }
      }
      if (overlap > bestScore) {
        bestScore = overlap;
        bestIndices = [i];
        bestOverlap = shared;
      } else if (overlap === bestScore && overlap > 0) {
        bestIndices.push(i);
      }
    }

    if (bestScore < requiredOverlap) {
      raw.push({ sentenceIndex: null, anchor: 0 });
      continue;
    }

    const chosen = bestIndices.find((i) => !claimed.has(i)) ?? bestIndices[0];
    claimed.add(chosen);
    raw.push({
      sentenceIndex: chosen,
      anchor: firstOccurrence(sentences[chosen], bestOverlap),
    });
  }

  const zoneEnds: number[] = raw.map(() => Infinity);
  const groups = new Map<number, number[]>();
  raw.forEach((ctx, idx) => {
    if (ctx.sentenceIndex === null) return;
    const arr = groups.get(ctx.sentenceIndex) ?? [];
    arr.push(idx);
    groups.set(ctx.sentenceIndex, arr);
  });
  for (const idxs of groups.values()) {
    // equal anchors sort either way, harmless since both fall back to the same leading label
    const sorted = [...idxs].sort((a, b) => raw[a].anchor - raw[b].anchor);
    for (let k = 0; k < sorted.length; k += 1) {
      zoneEnds[sorted[k]] =
        k + 1 < sorted.length ? raw[sorted[k + 1]].anchor : Infinity;
    }
  }

  return raw.map((ctx, idx) => ({ ...ctx, zoneEnd: zoneEnds[idx] }));
}

const LABEL_LEAD_RE = /(?:due|by|on|until|before)\s*$/iu;
const LABEL_BRIDGE_RE = /^[\s.,:;!?\-–—]*(?:(?:the|a|an)\s+)?$/iu;

// a leading label ("Monday the reading guide is due") has only punctuation and at most an article between
// it and the task, and isn't introduced by due/by/on. twin of _is_label_before in train/due_dates.py
function isLabelBefore(
  sentence: string,
  phrase: { phrase: string; index: number },
  anchor: number,
): boolean {
  const end = phrase.index + phrase.phrase.length;
  if (end > anchor) return false;
  if (LABEL_LEAD_RE.test(sentence.slice(0, phrase.index))) return false;
  return LABEL_BRIDGE_RE.test(sentence.slice(end, anchor));
}

// a task with no findable sentence or phrase keeps the model's count (dueSource "model").
// lastDue carries over from the previous chunk of a long paste
export function reconcileDueDates(
  tasks: readonly ExtractedTask[],
  text: string,
  today: Weekday,
  todayDate?: Date,
  lastDue: number | null = null,
): ExtractedTask[] {
  const sentences = splitSentences(text);
  const contexts = assignContexts(tasks, sentences);
  const sentencePhrases = sentences.map((s) => findDuePhrases(s));

  // a label sentence is one due phrase and nothing else, like "Mon" split off "Mon - 6.1 practice due."
  const isLabelSentence = sentences.map((sentence, i) => {
    const phrases = sentencePhrases[i];
    if (phrases.length !== 1) return false;
    const { phrase, index } = phrases[0];
    const before = sentence.slice(0, index);
    const after = sentence.slice(index + phrase.length);
    return before.trim() === "" && /^[\s.,:;!?\-–—]*$/u.test(after);
  });

  // the week block in effect at each sentence start, and the first block number, which is the base week
  const sentenceMarkers = sentences.map(findWeekMarkers);
  const blockAtStart: (number | null)[] = [];
  let firstWeek: number | null = null;
  let headerShift = 0;
  let running: number | null = null;
  for (let i = 0; i < sentences.length; i += 1) {
    blockAtStart.push(running);
    for (const marker of sentenceMarkers[i]) {
      if (firstWeek === null) {
        firstWeek = marker.week;
        // "Week 11, posted for next week" read on a weekday: the base week is the coming one
        if (
          NEXT_WEEK_HEADER_RE.test(sentences[i]) &&
          WEEKDAYS.indexOf(today) <= 3
        )
          headerShift = 1;
      }
      running = marker.week;
    }
  }
  const weekOffsetAt = (
    sentenceIndex: number,
    phraseIndex: number,
  ): number | null => {
    if (firstWeek === null) return null;
    let block = blockAtStart[sentenceIndex];
    for (const marker of sentenceMarkers[sentenceIndex]) {
      if (marker.index < phraseIndex) block = marker.week;
    }
    return block === null ? null : block - firstWeek + headerShift;
  };

  let runningLastDue = lastDue;
  const result: ExtractedTask[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const ctx = contexts[i];

    if (ctx.sentenceIndex === null) {
      result.push({ ...task, dueSource: "model" });
      continue;
    }

    const phrases = sentencePhrases[ctx.sentenceIndex];

    // the first phrase in this task's own zone, else the last one before its words (a label like "Friday:")
    let chosen = phrases.find(
      (p) => p.index >= ctx.anchor && p.index < ctx.zoneEnd,
    );
    let chosenSentence = ctx.sentenceIndex;
    if (chosen) {
      // label-first list ("Monday the guide is due, Wednesday the map is due"): nothing follows the last
      // task's words, so the phrase just before this task's words is its own
      const anchors = contexts
        .filter((c) => c.sentenceIndex === ctx.sentenceIndex)
        .map((c) => c.anchor)
        .sort((a, b) => a - b);
      const lastAnchor = anchors[anchors.length - 1];
      const trailing = phrases.some((p) => p.index >= lastAnchor);
      const prevAnchor = Math.max(-1, ...anchors.filter((a) => a < ctx.anchor));
      const gap = phrases.filter(
        (p) => p.index > prevAnchor && p.index < ctx.anchor,
      );
      const label = gap[gap.length - 1];
      if (
        !trailing &&
        label &&
        isLabelBefore(sentences[ctx.sentenceIndex], label, ctx.anchor)
      ) {
        chosen = label;
      }
    }
    if (!chosen) {
      const before = phrases.filter((p) => p.index < ctx.anchor);
      chosen = before.length > 0 ? before[before.length - 1] : undefined;
    }

    // no usable phrase in its own sentence: inherit from the nearest preceding label sentence
    if (!chosen) {
      for (let j = ctx.sentenceIndex - 1; j >= 0; j -= 1) {
        if (isLabelSentence[j]) {
          chosen = sentencePhrases[j][0];
          chosenSentence = j;
          break;
        }
      }
    }

    if (!chosen) {
      result.push({ ...task, dueSource: "model" });
      continue;
    }

    const resolved = resolveDuePhrase(
      chosen.phrase,
      today,
      runningLastDue,
      todayDate,
      weekOffsetAt(chosenSentence, chosen.index),
    );
    if (
      resolved === null ||
      resolved < EXTRACTION_LIMITS.minDueInDays ||
      resolved > EXTRACTION_LIMITS.maxDueInDays
    ) {
      result.push({ ...task, dueSource: "model" });
      continue;
    }

    runningLastDue = resolved;
    result.push({ ...task, dueInDays: resolved, dueSource: "text" });
  }

  return result;
}

// pass this from chunk N as lastDue for chunk N + 1
export function lastDueOf(tasks: readonly ExtractedTask[]): number | null {
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    if (tasks[i].dueSource === "text") return tasks[i].dueInDays;
  }
  return null;
}
