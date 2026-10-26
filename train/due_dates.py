"""Turn relative due phrases into day offsets in code, since a 135M model miscounts weekdays. Port of services/dueDates.ts."""

from __future__ import annotations

import re
from datetime import date

import prompt as prompt_mod
import validate as validate_mod

_WEEKDAY_FULL_NAMES: dict[str, int] = {name.lower(): i for i, name in enumerate(prompt_mod.WEEKDAYS)}
_WEEKDAY_ABBREVIATIONS: dict[str, int] = {
    "mon": 0,
    "tue": 1,
    "tues": 1,
    "wed": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}
_WEEKDAY_INDEX: dict[str, int] = {**_WEEKDAY_FULL_NAMES, **_WEEKDAY_ABBREVIATIONS}

# longest first is cosmetic. the trailing (?![a-zA-Z]) already stops "mon" matching inside "monday"
_FULL_NAMES_ALT = "|".join(sorted(_WEEKDAY_FULL_NAMES.keys(), key=len, reverse=True))
_ABBREVIATIONS_ALT = "|".join(sorted(_WEEKDAY_ABBREVIATIONS.keys(), key=len, reverse=True))

# a full name never takes a trailing period, which belongs to the sentence. an abbreviation
# may ("Fri."). WD adds the leading word boundary, _WD_BODY is for spots that already have one
_WD_BODY = rf"(?:(?:{_FULL_NAMES_ALT})(?![a-zA-Z])|(?:{_ABBREVIATIONS_ALT})\.?(?![a-zA-Z]))"
WD = r"\b" + _WD_BODY

# "a"/"an" (=1), digits, or a number word, optionally two words ("twenty one", "twenty-one")
_COUNT = r"(?:a|an|\d{1,4}|[a-zA-Z]+(?:[- ][a-zA-Z]+)?)"

_ONES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
_TEENS = [
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
]

_WORD_NUMBERS: dict[str, int] = {"a": 1, "an": 1}
for _i, _w in enumerate(_ONES, start=1):
    _WORD_NUMBERS[_w] = _i
for _i, _w in enumerate(_TEENS, start=10):
    _WORD_NUMBERS[_w] = _i
_WORD_NUMBERS["twenty"] = 20
for _i, _w in enumerate(_ONES, start=1):
    _WORD_NUMBERS[f"twenty-{_w}"] = 20 + _i
    _WORD_NUMBERS[f"twenty {_w}"] = 20 + _i
_WORD_NUMBERS["thirty"] = 30

# _COUNT matches any word because its fragments are anchored by "in" or "from <weekday>".
# these fragments have no anchor, so without known number words "the week after" would
# parse "the" as a count
_KNOWN_COUNT_WORDS_ALT = "|".join(
    sorted((re.escape(w) for w in _WORD_NUMBERS), key=len, reverse=True)
)
_STRICT_COUNT = rf"(?:\d{{1,4}}|{_KNOWN_COUNT_WORDS_ALT})"


def _parse_count(token: str) -> int | None:
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    return _WORD_NUMBERS.get(token)


def _weekday_index_from_token(token: str) -> int | None:
    return _WEEKDAY_INDEX.get(token.strip().lower().rstrip("."))


def _weekday_index_from_text(text: str) -> int | None:
    """First weekday token found anywhere in `text`, or None."""
    match = re.search(WD, text, re.IGNORECASE)
    if match is None:
        return None
    return _weekday_index_from_token(match.group(0))


def _count_from_text(text: str) -> int | None:
    """First count token (digits or a number word) found in `text`."""
    match = re.search(r"\d{1,4}|[a-zA-Z]+(?:[- ][a-zA-Z]+)?", text)
    if match is None:
        return None
    return _parse_count(match.group(0))


# phrase grammar: one case-insensitive fragment per category, most specific first

# calendar-date bodies shared with _resolve_calendar. callers add the \b
_MONTH_NAME_DATE_BODY = (
    r"(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|"
    r"august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+"
    r"\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?"
)
_NUMERIC_DATE_BODY = r"\d{1,2}/\d{1,2}(?:/\d{2,4})?"
_ORDINAL_DAY_BODY = r"(?:on\s+)?the\s+\d{1,2}(?:st|nd|rd|th)"

_FRAGMENTS: list[str] = [
    r"\bthe\s+day\s+after\s+tomorrow\b",
    r"\btomorrow\b",
    r"\bby\s+the\s+end\s+of\s+class\b",
    r"\bend\s+of\s+class\b",
    r"\bbefore\s+you\s+leave\b",
    r"\btoday\b",
    r"\btonight\b",
    rf"\bin\s+{_COUNT}\s+days?\b",
    rf"\b{_STRICT_COUNT}\s+(?:weeks?|days?)\s+from\s+(?:today|tomorrow)\b",
    rf"\b{_STRICT_COUNT}\s+(?:weeks?|days?)\s+after(?:\s+that)?\b",
    rf"\b{_STRICT_COUNT}\s+(?:weeks?|days?)\s+later\b",
    rf"\b{_COUNT}\s+weeks?\s+from\s+{WD}",
    rf"{WD}\s+after\s+next\b",
    rf"\bthe\s+following\s+{WD}",
    rf"\bthe\s+{WD}\s+after(?!\s+next)\b",
    rf"{WD}(?:\s+of)?\s+next\s+week\b",
    rf"\bnext\s+{WD}",
    r"\bnext\s+week\b",
    r"\bthe\s+following\s+week\b",
    r"\bthe\s+week\s+after\b",
    rf"\bin\s+{_COUNT}\s+weeks?\b",
    r"\bend\s+of\s+the\s+month\b",
    r"\bend\s+of\s+month\b",
    rf"\bin\s+{_COUNT}\s+months?\b",
    r"\bby\s+the\s+end\s+of\s+the\s+week\b",
    r"\bend\s+of\s+the\s+week\b",
    r"\bend\s+of\s+week\b",
    r"\bdue\s+this\s+week\b",
    r"\bthis\s+week\b",
    r"\bover\s+the\s+weekend\b",
    r"\bafter\s+the\s+weekend\b",
    # weekday plus date ("Friday the 25th") comes before the bare weekday. both start at
    # the same position, so here list order decides
    rf"{WD}\s*,?\s+(?:{_MONTH_NAME_DATE_BODY}|{_ORDINAL_DAY_BODY}|{_NUMERIC_DATE_BODY})",
    r"\b(?:on|by|this)\s+" + _WD_BODY,
    WD,
    r"\b" + _MONTH_NAME_DATE_BODY + r"\b",
    r"\b" + _NUMERIC_DATE_BODY + r"\b",
    r"\b" + _ORDINAL_DAY_BODY + r"\b",
]

_COMBINED_RE = re.compile("|".join(f"(?:{frag})" for frag in _FRAGMENTS), re.IGNORECASE)

# the same fragments compiled one by one, since resolve needs to know which category matched
_DAY_AFTER_TOMORROW_RE = re.compile(r"the\s+day\s+after\s+tomorrow", re.IGNORECASE)
_TOMORROW_RE = re.compile(r"tomorrow", re.IGNORECASE)
_ZERO_RE = re.compile(
    r"by\s+the\s+end\s+of\s+class|end\s+of\s+class|before\s+you\s+leave|today|tonight",
    re.IGNORECASE,
)
_IN_DAYS_RE = re.compile(rf"in\s+({_COUNT})\s+days?", re.IGNORECASE)
_FROM_TODAY_TOMORROW_RE = re.compile(
    rf"({_STRICT_COUNT})\s+(weeks?|days?)\s+from\s+(today|tomorrow)", re.IGNORECASE
)
_AFTER_THAT_RE = re.compile(
    rf"({_STRICT_COUNT})\s+(weeks?|days?)\s+after(?:\s+that)?\b", re.IGNORECASE
)
_LATER_RE = re.compile(rf"({_STRICT_COUNT})\s+(weeks?|days?)\s+later\b", re.IGNORECASE)
_WEEKS_FROM_WEEKDAY_RE = re.compile(rf"({_COUNT})\s+weeks?\s+from\s+({WD})", re.IGNORECASE)
_WEEKDAY_AFTER_NEXT_RE = re.compile(rf"({WD})\s+after\s+next", re.IGNORECASE)
_FOLLOWING_WEEKDAY_RE = re.compile(
    rf"the\s+following\s+({WD})|the\s+({WD})\s+after(?!\s+next)", re.IGNORECASE
)
_WEEKDAY_NEXT_WEEK_RE = re.compile(rf"({WD})(?:\s+of)?\s+next\s+week", re.IGNORECASE)
_NEXT_WEEKDAY_RE = re.compile(rf"next\s+({WD})", re.IGNORECASE)
_NEXT_WEEK_BARE_RE = re.compile(r"next\s+week", re.IGNORECASE)
_FOLLOWING_WEEK_RE = re.compile(r"the\s+following\s+week|the\s+week\s+after", re.IGNORECASE)
_IN_WEEKS_RE = re.compile(rf"in\s+({_COUNT})\s+weeks?", re.IGNORECASE)
_END_OF_MONTH_RE = re.compile(r"end\s+of\s+the\s+month|end\s+of\s+month", re.IGNORECASE)
_IN_MONTHS_RE = re.compile(rf"in\s+({_COUNT})\s+months?", re.IGNORECASE)
_END_OF_WEEK_RE = re.compile(
    r"by\s+the\s+end\s+of\s+the\s+week|end\s+of\s+the\s+week|end\s+of\s+week|"
    r"due\s+this\s+week|this\s+week",
    re.IGNORECASE,
)
_WEEKEND_RE = re.compile(r"over\s+the\s+weekend|after\s+the\s+weekend", re.IGNORECASE)

_MONTHS: dict[str, int] = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_MONTH_NAME_DATE_RE = re.compile(
    r"\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|"
    r"august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+"
    r"(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b",
    re.IGNORECASE,
)
_NUMERIC_DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
_ORDINAL_DAY_RE = re.compile(r"\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b", re.IGNORECASE)
# separate from the bodies on purpose: _resolve_calendar needs the captures, the grammar only the shape


def _bare_weekday_days(w: int, t: int, last_due: int | None) -> int:
    d = (w - t + 7) % 7
    if d == 0:
        return 0 if (last_due is None or last_due == 0) else 7
    return d


def _week_block_days(w: int, t: int, offset: int) -> int:
    """Mirrors weekBlockCount. The first block is this week Monday to Thursday, else next week (also when its header says "next week"). A past day rolls forward."""
    base_monday = -t if t <= 3 else 7 - t
    d = base_monday + 7 * offset + w
    return d + 7 if d < 0 else d


_WEEK_MARKER_RE = re.compile(
    r"\bweek\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b",
    re.IGNORECASE,
)


def find_week_markers(sentence: str) -> list[tuple[int, int]]:
    """Every "week N" header in `sentence` as (index, N), N from 1 to 12. Mirrors findWeekMarkers."""
    out: list[tuple[int, int]] = []
    for m in _WEEK_MARKER_RE.finditer(sentence):
        n = _parse_count(m.group(1))
        if n is not None and 1 <= n <= 12:
            out.append((m.start(), n))
    return out


def _count_amount(count_token: str, unit_token: str) -> int | None:
    """Days a "<count> week(s)/day(s)" span names, or None if the count does not parse."""
    n = _parse_count(count_token)
    if n is None:
        return None
    return n * 7 if unit_token.lower().startswith("week") else n


def _next_weekday_days(w: int, t: int, last_due: int | None) -> int:
    result = (7 - t) + w
    if last_due is not None and result < last_due:
        result += 7
    return result


def _following_weekday_days(w: int, t: int, last_due: int | None) -> int:
    base = last_due if last_due is not None else 0
    bw = (t + base) % 7
    d = (w - bw + 7) % 7
    if d == 0:
        d = 7
    return base + d


def _next_month_year(d: date) -> tuple[int, int]:
    if d.month == 12:
        return 1, d.year + 1
    return d.month + 1, d.year


def _calendar_diff(month: int | None, day: int, year_str: str | None, today_date: date) -> int | None:
    try:
        if month is None:
            if day >= today_date.day:
                month, year = today_date.month, today_date.year
            else:
                month, year = _next_month_year(today_date)
            target = date(year, month, day)
        elif year_str:
            year = int(year_str)
            if year < 100:
                year += 2000
            target = date(year, month, day)
        else:
            year = today_date.year
            target = date(year, month, day)
            if target < today_date:
                target = date(year + 1, month, day)
    except ValueError:
        return None
    diff = (target - today_date).days
    return diff if diff >= 0 else None


def _resolve_calendar(phrase: str, today_date: date | None) -> int | None:
    if today_date is None:
        return None
    match = _MONTH_NAME_DATE_RE.search(phrase)
    if match:
        month = _MONTHS.get(match.group(1).lower())
        if month is None:
            return None
        return _calendar_diff(month, int(match.group(2)), match.group(3), today_date)
    match = _NUMERIC_DATE_RE.search(phrase)
    if match:
        month = int(match.group(1))
        if not 1 <= month <= 12:
            return None
        return _calendar_diff(month, int(match.group(2)), match.group(3), today_date)
    match = _ORDINAL_DAY_RE.search(phrase)
    if match:
        return _calendar_diff(None, int(match.group(1)), None, today_date)
    return None


def _resolve_raw(
    phrase: str,
    today: str,
    last_due: int | None,
    today_date: date | None,
    week_offset: int | None = None,
) -> int | None:
    if today not in prompt_mod.WEEKDAYS:
        raise ValueError(f"today must be a weekday name, got {today!r}")
    t = _WEEKDAY_INDEX[today.lower()]
    low = phrase.strip().lower()
    if low == "":
        return None

    if _DAY_AFTER_TOMORROW_RE.search(low):
        return 2

    # ahead of the bare today/tomorrow checks, which would fire inside "two weeks from today"
    match = _FROM_TODAY_TOMORROW_RE.search(low)
    if match:
        amount = _count_amount(match.group(1), match.group(2))
        if amount is None:
            return None
        return amount + 1 if match.group(3) == "tomorrow" else amount

    if _TOMORROW_RE.search(low):
        return 1
    if _ZERO_RE.search(low):
        return 0

    match = _AFTER_THAT_RE.search(low)
    if match:
        amount = _count_amount(match.group(1), match.group(2))
        if amount is None:
            return None
        return (last_due if last_due is not None else 0) + amount

    match = _LATER_RE.search(low)
    if match:
        amount = _count_amount(match.group(1), match.group(2))
        if amount is None:
            return None
        return (last_due if last_due is not None else 0) + amount

    match = _IN_DAYS_RE.search(low)
    if match:
        return _parse_count(match.group(1))

    match = _WEEKS_FROM_WEEKDAY_RE.search(low)
    if match:
        n = _parse_count(match.group(1))
        w = _weekday_index_from_token(match.group(2))
        if n is None or w is None:
            return None
        return _bare_weekday_days(w, t, last_due) + 7 * n

    match = _WEEKDAY_AFTER_NEXT_RE.search(low)
    if match:
        w = _weekday_index_from_token(match.group(1))
        if w is None:
            return None
        return _next_weekday_days(w, t, last_due) + 7

    match = _FOLLOWING_WEEKDAY_RE.search(low)
    if match:
        token = match.group(1) or match.group(2)
        w = _weekday_index_from_token(token)
        if w is None:
            return None
        return _following_weekday_days(w, t, last_due)

    match = _WEEKDAY_NEXT_WEEK_RE.search(low)
    if match:
        w = _weekday_index_from_token(match.group(1))
        if w is None:
            return None
        return _next_weekday_days(w, t, last_due)

    match = _NEXT_WEEKDAY_RE.search(low)
    if match:
        w = _weekday_index_from_token(match.group(1))
        if w is None:
            return None
        return _next_weekday_days(w, t, last_due)

    if _NEXT_WEEK_BARE_RE.search(low):
        return 7

    if _FOLLOWING_WEEK_RE.search(low):
        return (last_due if last_due is not None else 0) + 7

    match = _IN_WEEKS_RE.search(low)
    if match:
        n = _parse_count(match.group(1))
        return None if n is None else n * 7

    if _END_OF_MONTH_RE.search(low):
        return 30

    match = _IN_MONTHS_RE.search(low)
    if match:
        n = _parse_count(match.group(1))
        return None if n is None else n * 30

    if _END_OF_WEEK_RE.search(low):
        return _bare_weekday_days(4, t, last_due)  # Friday

    if _WEEKEND_RE.search(low):
        return _bare_weekday_days(0, t, last_due)  # Monday

    # with a weekday and a date, the date wins when today_date can resolve it, else the weekday
    calendar_result = _resolve_calendar(phrase, today_date)
    if calendar_result is not None:
        return calendar_result

    w = _weekday_index_from_text(low)
    if w is not None:
        # inside a numbered week block a bare weekday is positional, elsewhere the next occurrence
        if week_offset is not None:
            return _week_block_days(w, t, week_offset)
        return _bare_weekday_days(w, t, last_due)

    return None


def resolve_due_phrase(
    phrase: str,
    today: str,
    last_due: int | None,
    today_date: date | None = None,
    week_offset: int | None = None,
) -> int | None:
    """The day offset a due phrase names, or None. Never negative. Calendar phrases need `today_date`."""
    result = _resolve_raw(phrase, today, last_due, today_date, week_offset)
    if result is None or result < 0:
        return None
    return result


def find_due_phrases(sentence: str) -> list[tuple[str, int]]:
    """Every due phrase in `sentence` with its index. finditer takes the longest match at a position, so "next Tuesday" is found whole."""
    return [(m.group(0), m.start()) for m in _COMBINED_RE.finditer(sentence)]


_STOPWORDS = frozenset(
    """
    a an the and or but if then than so to of in on at by for from with
    without into onto over under about as is are was were be been being do
    does did doing have has had having it its this that these those your you
    my i we our he she they them his her their out up down off again just
    very each all any some one two three due
    """.split()
)


def _tokenize_with_positions(text: str) -> list[tuple[str, int]]:
    tokens: list[tuple[str, int]] = []
    current: list[str] = []
    start: int | None = None
    for i, ch in enumerate(text):
        if ch.isalnum():
            if start is None:
                start = i
            current.append(ch.lower())
        else:
            if current:
                tokens.append(("".join(current), start))  # type: ignore[arg-type]
                current = []
                start = None
    if current:
        tokens.append(("".join(current), start))  # type: ignore[arg-type]
    return tokens


def _content_tokens(text: str) -> list[tuple[str, int]]:
    return [(tok, pos) for tok, pos in _tokenize_with_positions(text) if tok not in _STOPWORDS]


_LABEL_PREFIX = r"(?:next\s+|the\s+following\s+)?"

# a spaced dash separates items like any sentence boundary
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|;\s*|\n+|\s+[-–—]\s+")

# a "<weekday>:" label peels off only at a segment's start. dash-led labels are already split by the dash rule
_LABEL_START_RE = re.compile(rf"^({_LABEL_PREFIX}{_WD_BODY})\s*:\s*", re.IGNORECASE)


def split_sentences(text: str) -> list[str]:
    """Split on sentence punctuation, semicolons, newlines and spaced dashes, then peel a leading "<weekday>:" label into its own sentence."""
    raw = [p.strip() for p in _SENTENCE_SPLIT_RE.split(text) if p.strip() != ""]
    result: list[str] = []
    for segment in raw:
        remaining = segment
        while True:
            match = _LABEL_START_RE.match(remaining)
            if match is None:
                break
            result.append(match.group(1))
            remaining = remaining[match.end():].strip()
            if remaining == "":
                break
        if remaining != "":
            result.append(remaining)
    return result


def last_due_of(tasks: list[dict]) -> int | None:
    """The `dueInDays` of the last task resolved from text, which the next chunk of the same paste continues from."""
    result: int | None = None
    for task in tasks:
        if task.get("dueSource") == "text":
            result = task.get("dueInDays")
    return result


_LABEL_LEAD_RE = re.compile(r"(?:due|by|on|until|before)\s*$", re.IGNORECASE)
_LABEL_BRIDGE_RE = re.compile(r"^[\s.,:;!?\-–—]*(?:(?:the|a|an)\s+)?$", re.IGNORECASE)


def _is_label_before(sentence: str, phrase: tuple[str, int], anchor: int) -> bool:
    """True when `phrase` labels the task at `anchor`: nothing but punctuation and one article between, and no "due", "by" or "on" before it. Mirrors isLabelBefore."""
    text, index = phrase
    end = index + len(text)
    if end > anchor:
        return False
    if _LABEL_LEAD_RE.search(sentence[:index]):
        return False
    return _LABEL_BRIDGE_RE.match(sentence[end:anchor]) is not None


def _label_sentence_phrase(sentence: str, phrases: list[tuple[str, int]]) -> str | None:
    """The phrase of a sentence that is only a due phrase, like the label segments split_sentences makes, else None."""
    if len(phrases) != 1:
        return None
    phrase, index = phrases[0]
    return phrase if index == 0 and phrase == sentence else None


def reconcile_due_dates(
    tasks: list[dict],
    text: str,
    today: str,
    today_date: date | None = None,
    last_due: int | None = None,
) -> list[dict]:
    """Set each task's `dueInDays` from its sentence's phrase, else keep the model's, and record `dueSource`. A task with no phrase takes the nearest preceding label's."""
    sentences = split_sentences(text)
    sentence_tokens = [_tokenize_with_positions(s) for s in sentences]
    sentence_word_sets = [
        {tok for tok, _ in tokens if tok not in _STOPWORDS} for tokens in sentence_tokens
    ]
    sentence_phrases = [find_due_phrases(s) for s in sentences]
    sentence_labels = [
        _label_sentence_phrase(s, sentence_phrases[i]) for i, s in enumerate(sentences)
    ]

    # first pass: each task's sentence and the anchor where its title first overlaps it
    claimed: set[int] = set()
    matches: list[tuple[int | None, int]] = []  # (sentence index or None, anchor)

    for task in tasks:
        title = task.get("title", "")
        title_tokens_ordered = [tok for tok, _ in _content_tokens(title)]
        title_word_set = set(title_tokens_ordered)
        required = 1 if len(title_word_set) <= 2 else 2

        gated = [
            (i, len(title_word_set & wset))
            for i, wset in enumerate(sentence_word_sets)
            if len(title_word_set & wset) >= required
        ]

        matched_idx: int | None = None
        if gated:
            top = max(overlap for _, overlap in gated)
            candidates = [i for i, overlap in gated if overlap == top]
            unclaimed = [i for i in candidates if i not in claimed]
            matched_idx = unclaimed[0] if unclaimed else candidates[0]

        if matched_idx is None:
            matches.append((None, 0))
            continue
        claimed.add(matched_idx)

        anchor_pos = 0
        for tok in title_tokens_ordered:
            found = next((pos for t2, pos in sentence_tokens[matched_idx] if t2 == tok), None)
            if found is not None:
                anchor_pos = found
                break
        matches.append((matched_idx, anchor_pos))

    # second pass, in order so last_due chains. a task's phrase window ends where the next
    # task in the same sentence starts, so a later task cannot steal its phrase. it takes
    # the first phrase at or after its anchor, else the last one before it (a leading label).
    # week blocks: the block in effect at each sentence start, and the first block, the base week
    sentence_markers = [find_week_markers(s) for s in sentences]
    block_at_start: list[int | None] = []
    first_week: int | None = None
    header_shift = 0
    running_block: int | None = None
    for i, markers in enumerate(sentence_markers):
        block_at_start.append(running_block)
        for _, week in markers:
            if first_week is None:
                first_week = week
                # "Week 11, posted for next week" read Monday to Thursday: the base week is the coming one
                if _NEXT_WEEK_BARE_RE.search(sentences[i]) and _WEEKDAY_INDEX[today.lower()] <= 3:
                    header_shift = 1
            running_block = week

    def week_offset_at(sentence_index: int, phrase_index: int) -> int | None:
        if first_week is None:
            return None
        block = block_at_start[sentence_index]
        for index, week in sentence_markers[sentence_index]:
            if index < phrase_index:
                block = week
        return None if block is None else block - first_week + header_shift

    results: list[dict] = []

    for i, task in enumerate(tasks):
        matched_idx, anchor_pos = matches[i]

        if matched_idx is None:
            results.append({**task, "dueSource": "model"})
            continue

        window_end = len(sentences[matched_idx])
        for j in range(i + 1, len(tasks)):
            other_idx, other_anchor = matches[j]
            if other_idx == matched_idx:
                window_end = other_anchor
                break

        phrases = sentence_phrases[matched_idx]
        chosen_sentence = matched_idx
        chosen = next(
            (ph for ph in phrases if anchor_pos <= ph[1] < window_end), None
        )
        if chosen is not None:
            # label-first list ("Monday the guide is due, Wednesday the map is due"):
            # the phrase just before this task's anchor is its own
            anchors = sorted(a for idx2, a in matches if idx2 == matched_idx)
            last_anchor = anchors[-1]
            trailing = any(ph[1] >= last_anchor for ph in phrases)
            prev_anchor = max((a for a in anchors if a < anchor_pos), default=-1)
            gap = [ph for ph in phrases if prev_anchor < ph[1] < anchor_pos]
            if not trailing and gap and _is_label_before(sentences[matched_idx], gap[-1], anchor_pos):
                chosen = gap[-1]
        if chosen is None:
            before = [ph for ph in phrases if ph[1] < anchor_pos]
            chosen = before[-1] if before else None

        if chosen is None:
            for j in range(matched_idx - 1, -1, -1):
                if sentence_labels[j] is not None:
                    chosen = (sentence_labels[j], 0)
                    chosen_sentence = j
                    break

        if chosen is None:
            results.append({**task, "dueSource": "model"})
            continue

        resolved = resolve_due_phrase(
            chosen[0], today, last_due, today_date, week_offset_at(chosen_sentence, chosen[1])
        )
        if (
            resolved is None
            or resolved < validate_mod.MIN_DUE_IN_DAYS
            or resolved > validate_mod.MAX_DUE_IN_DAYS
        ):
            results.append({**task, "dueSource": "model"})
            continue

        last_due = resolved
        results.append({**task, "dueInDays": resolved, "dueSource": "text"})

    return results
