"""Validation and repair, ported from services/validation.ts. Must agree with the app exactly: it filters training data and scores evals."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
# the same files the app's lexicon module is generated from, so there is one copy
LEXICON_DIR = REPO_ROOT / "services" / "lexicon"

# mirrors BREAKDOWN_LIMITS in types/index.ts
MIN_STEPS = 3
MAX_STEPS = 7
MIN_TITLE_LENGTH = 4
MAX_TITLE_LENGTH = 80
MIN_MINUTES = 5
MAX_MINUTES = 45
MIN_STARTER_ACTION_LENGTH = 8
MAX_STARTER_ACTION_LENGTH = 120
MIN_TOTAL_MINUTES = 15
MAX_TOTAL_MINUTES = 300
MIN_STARTER_SIMILARITY = 0.3

MAX_TASKS = 8
EXTRACTION_MIN_TITLE_LENGTH = 3
EXTRACTION_MAX_TITLE_LENGTH = 100
MIN_DUE_IN_DAYS = 0
MAX_DUE_IN_DAYS = 365
MAX_SUBJECT_LENGTH = 40

SIMPLIFY_MIN_TITLE_LENGTH = 3
SIMPLIFY_MAX_TITLE_LENGTH = 80
MIN_EXPLANATION_LENGTH = 20
MAX_EXPLANATION_LENGTH = 400


@dataclass(frozen=True)
class Rejection:
    code: str
    reason: str


@dataclass(frozen=True)
class Result:
    ok: bool
    value: Any = None
    rejection: Rejection | None = None

    @property
    def code(self) -> str:
        return "ok" if self.ok else (self.rejection.code if self.rejection else "unknown")


def _accept(value: Any) -> Result:
    return Result(ok=True, value=value)


def _reject(code: str, reason: str) -> Result:
    return Result(ok=False, rejection=Rejection(code=code, reason=reason))


@lru_cache(maxsize=None)
def _lexicon(name: str) -> tuple[str, ...]:
    path = LEXICON_DIR / f"{name}.txt"
    entries: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        entries.append(stripped)
    return tuple(entries)


@lru_cache(maxsize=None)
def _imperative_verbs() -> frozenset[str]:
    return frozenset(_lexicon("imperative-verbs"))


@lru_cache(maxsize=None)
def _vague_phrases() -> tuple[str, ...]:
    return _lexicon("vague-verbs")


@lru_cache(maxsize=None)
def _common_capitalized() -> frozenset[str]:
    return frozenset(w.lower() for w in _lexicon("common-capitalized"))


@lru_cache(maxsize=None)
def _stopwords() -> frozenset[str]:
    return frozenset(_lexicon("stopwords"))


_FENCE_WITH_LANG = re.compile(r"```[a-zA-Z]*\n?")


def strip_to_json(raw: str) -> str | None:
    """Reduce raw output to the root JSON object. Braces inside strings are skipped, so trailing prose with a `}` is not swallowed."""
    text = _FENCE_WITH_LANG.sub("", raw).replace("```", "").strip()
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(text)):
        ch = text[i]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            if in_string:
                escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _parse_root(raw: str) -> Result:
    if raw.strip() == "":
        return _reject("empty_output", "the response was empty")
    sliced = strip_to_json(raw)
    if sliced is None:
        return _reject("no_json_object", "the response contained no JSON object")
    try:
        parsed = json.loads(sliced)
    except (ValueError, TypeError):
        return _reject("parse_error", "the response was not valid JSON")
    if not isinstance(parsed, dict):
        return _reject("not_an_object", "the response was not a JSON object")
    return _accept(parsed)


def _check_keys(obj: dict, required: list[str], optional: list[str] | None = None) -> Rejection | None:
    for key in required:
        if key not in obj:
            return Rejection("missing_field", f'the field "{key}" was missing')
    allowed = set(required) | set(optional or [])
    for key in obj:
        if key not in allowed:
            return Rejection("unexpected_field", f'the field "{key}" is not part of the format')
    return None


# word handling must match the typescript exactly. this stands in for js [^\p{L}\p{N}\s] with the u flag
_NON_WORD = re.compile(r"[^^\w\s]|_", re.UNICODE)


def words(text: str) -> list[str]:
    lowered = text.lower()
    cleaned = "".join(ch if (ch.isalnum() or ch.isspace()) else " " for ch in lowered)
    return [w for w in cleaned.split() if w != ""]


def content_words(text: str) -> set[str]:
    stop = _stopwords()
    return {w for w in words(text) if w not in stop}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    shared = len(a & b)
    union = len(a) + len(b) - shared
    return 0.0 if union == 0 else shared / union


def starts_with_imperative(title: str) -> bool:
    tokens = words(title)
    return bool(tokens) and tokens[0] in _imperative_verbs()


def matches_vague_phrase(title: str) -> str | None:
    """Multi-word phrases match anywhere, single words only as the first word, so "the process of photosynthesis" passes."""
    tokens = words(title)
    normalized = " ".join(tokens)
    for phrase in _vague_phrases():
        if " " not in phrase:
            if tokens and tokens[0] == phrase:
                return phrase
            continue
        if normalized == phrase:
            return phrase
        if normalized.startswith(f"{phrase} "):
            return phrase
        if f" {phrase} " in normalized:
            return phrase
        if normalized.endswith(f" {phrase}"):
            return phrase
    return None


# js's \s set. python's str.split() also splits on U+0085 and misses U+FEFF
_JS_WHITESPACE_RE = re.compile(
    r"[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def hallucinated_proper_noun(title: str, input_tokens: set[str]) -> str | None:
    """Skips the first token, which the imperative check covers. Possessives are checked by stem, since words() drops apostrophes."""
    tokens = [t for t in _JS_WHITESPACE_RE.split(title) if t != ""]
    common = _common_capitalized()
    for i in range(1, len(tokens)):
        bare = "".join(ch for ch in tokens[i] if ch.isalnum() or ch in "'’-")
        if len(bare) < 2:
            continue
        first = bare[0]
        if first.upper() != first or first.lower() == first:
            continue
        lower = bare.lower()
        if lower in common or lower in input_tokens:
            continue
        possessive_match = re.match(r"^(.+)['’]s?$", lower)
        if possessive_match and possessive_match.group(1) in input_tokens:
            continue
        return bare
    return None


def _input_token_set(task: dict) -> set[str]:
    blob = " ".join(
        [
            task.get("title") or "",
            task.get("subject") or "",
            task.get("description") or "",
        ]
    )
    return set(words(blob))


def validate_breakdown(raw: str, task: dict) -> Result:
    parsed = _parse_root(raw)
    if not parsed.ok:
        return parsed
    root = parsed.value

    key_problem = _check_keys(root, ["steps", "starterAction"])
    if key_problem:
        return Result(ok=False, rejection=key_problem)

    steps = root["steps"]
    starter_action = root["starterAction"]

    if not isinstance(steps, list):
        return _reject("wrong_type", 'the field "steps" was not a list')
    if len(steps) < MIN_STEPS:
        return _reject("too_few_steps", f"there were {len(steps)} steps, the minimum is {MIN_STEPS}")
    if len(steps) > MAX_STEPS:
        return _reject("too_many_steps", f"there were {len(steps)} steps, the maximum is {MAX_STEPS}")
    if not isinstance(starter_action, str):
        return _reject("wrong_type", 'the field "starterAction" was not a string')

    clean_steps: list[dict] = []

    for index, step in enumerate(steps):
        ordinal = index + 1
        if not isinstance(step, dict):
            return _reject("wrong_type", f"step {ordinal} was not an object")
        step_key_problem = _check_keys(step, ["title", "minutes"])
        if step_key_problem:
            return Result(
                ok=False,
                rejection=Rejection(
                    step_key_problem.code, f"in step {ordinal}, {step_key_problem.reason}"
                ),
            )
        title = step["title"]
        minutes = step["minutes"]
        if not isinstance(title, str):
            return _reject("wrong_type", f"the title of step {ordinal} was not a string")
        if len(title.strip()) < MIN_TITLE_LENGTH:
            return _reject("title_too_short", f"the title of step {ordinal} was too short")
        if len(title) > MAX_TITLE_LENGTH:
            return _reject(
                "title_too_long",
                f"the title of step {ordinal} was {len(title)} characters, "
                f"the maximum is {MAX_TITLE_LENGTH}",
            )
        # bool is an int in python, and json true must not pass as 1
        if isinstance(minutes, bool) or not isinstance(minutes, int):
            return _reject(
                "minutes_not_integer", f"the minutes of step {ordinal} was not a whole number"
            )
        if minutes < MIN_MINUTES or minutes > MAX_MINUTES:
            return _reject(
                "minutes_out_of_range",
                f"step {ordinal} was {minutes} minutes, which is outside "
                f"{MIN_MINUTES} to {MAX_MINUTES}",
            )
        clean_steps.append({"title": title, "minutes": minutes})

    if (
        len(starter_action.strip()) < MIN_STARTER_ACTION_LENGTH
        or len(starter_action) > MAX_STARTER_ACTION_LENGTH
    ):
        return _reject(
            "starter_action_length",
            f"the starter action must be between {MIN_STARTER_ACTION_LENGTH} and "
            f"{MAX_STARTER_ACTION_LENGTH} characters",
        )

    # semantic checks only once the schema holds

    for index, step in enumerate(clean_steps):
        ordinal = index + 1
        title = step["title"]
        vague = matches_vague_phrase(title)
        if vague is not None:
            return _reject(
                "vague_verb", f'step {ordinal} says "{vague}", which is not something to do'
            )
        if not starts_with_imperative(title):
            return _reject("not_a_physical_action", f"step {ordinal} is not a physical action")

    seen: set[str] = set()
    for index, step in enumerate(clean_steps):
        key = " ".join(words(step["title"]))
        if key in seen:
            return _reject("duplicate_step", f"step {index + 1} repeats an earlier step")
        seen.add(key)

    total = sum(s["minutes"] for s in clean_steps)
    if total < MIN_TOTAL_MINUTES or total > MAX_TOTAL_MINUTES:
        return _reject(
            "total_minutes_out_of_range",
            f"the steps add up to {total} minutes, which is outside "
            f"{MIN_TOTAL_MINUTES} to {MAX_TOTAL_MINUTES}",
        )

    similarity = jaccard(content_words(starter_action), content_words(clean_steps[0]["title"]))
    if similarity < MIN_STARTER_SIMILARITY:
        return _reject("starter_action_mismatch", "the starter action does not restate the first step")

    input_tokens = _input_token_set(task)
    for index, step in enumerate(clean_steps):
        invented = hallucinated_proper_noun(step["title"], input_tokens)
        if invented is not None:
            return _reject(
                "hallucinated_proper_noun",
                f'step {index + 1} mentions "{invented}", which is not in the assignment',
            )

    return _accept({"steps": clean_steps, "starterAction": starter_action})


def validate_extraction(raw: str) -> Result:
    parsed = _parse_root(raw)
    if not parsed.ok:
        return parsed
    root = parsed.value

    key_problem = _check_keys(root, ["tasks"])
    if key_problem:
        return Result(ok=False, rejection=key_problem)

    tasks = root["tasks"]
    if not isinstance(tasks, list):
        return _reject("wrong_type", 'the field "tasks" was not a list')
    if len(tasks) > MAX_TASKS:
        return _reject("too_many_tasks", f"there were {len(tasks)} tasks, the maximum is {MAX_TASKS}")

    clean: list[dict] = []
    for index, item in enumerate(tasks):
        ordinal = index + 1
        if not isinstance(item, dict):
            return _reject("wrong_type", f"task {ordinal} was not an object")
        item_key_problem = _check_keys(item, ["title", "dueInDays"], ["subject"])
        if item_key_problem:
            return Result(
                ok=False,
                rejection=Rejection(
                    item_key_problem.code, f"in task {ordinal}, {item_key_problem.reason}"
                ),
            )
        title = item["title"]
        due_in_days = item["dueInDays"]
        subject = item.get("subject")

        if not isinstance(title, str):
            return _reject("wrong_type", f"the title of task {ordinal} was not a string")
        if len(title.strip()) < EXTRACTION_MIN_TITLE_LENGTH:
            return _reject("title_too_short", f"the title of task {ordinal} was too short")
        if len(title) > EXTRACTION_MAX_TITLE_LENGTH:
            return _reject("title_too_long", f"the title of task {ordinal} was too long")
        if isinstance(due_in_days, bool) or not isinstance(due_in_days, int):
            return _reject("wrong_type", f"dueInDays of task {ordinal} was not a whole number")
        if due_in_days < MIN_DUE_IN_DAYS or due_in_days > MAX_DUE_IN_DAYS:
            return _reject(
                "due_in_days_out_of_range",
                f"task {ordinal} is due in {due_in_days} days, which is outside "
                f"{MIN_DUE_IN_DAYS} to {MAX_DUE_IN_DAYS}",
            )
        if "subject" in item:
            if not isinstance(subject, str):
                return _reject("wrong_type", f"the subject of task {ordinal} was not a string")
            if len(subject) > MAX_SUBJECT_LENGTH:
                return _reject("subject_too_long", f"the subject of task {ordinal} was too long")

        entry = {"title": title, "dueInDays": due_in_days}
        if "subject" in item:
            entry["subject"] = subject
        clean.append(entry)

    return _accept({"tasks": clean})


def validate_simplification(raw: str, task: dict) -> Result:
    parsed = _parse_root(raw)
    if not parsed.ok:
        return parsed
    root = parsed.value

    key_problem = _check_keys(root, ["title", "explanation"])
    if key_problem:
        return Result(ok=False, rejection=key_problem)

    title = root["title"]
    explanation = root["explanation"]

    if not isinstance(title, str):
        return _reject("wrong_type", 'the field "title" was not a string')
    if not isinstance(explanation, str):
        return _reject("wrong_type", 'the field "explanation" was not a string')
    if len(title.strip()) < SIMPLIFY_MIN_TITLE_LENGTH or len(title) > SIMPLIFY_MAX_TITLE_LENGTH:
        return _reject(
            "title_too_long",
            f"the title must be between {SIMPLIFY_MIN_TITLE_LENGTH} and "
            f"{SIMPLIFY_MAX_TITLE_LENGTH} characters",
        )
    if (
        len(explanation.strip()) < MIN_EXPLANATION_LENGTH
        or len(explanation) > MAX_EXPLANATION_LENGTH
    ):
        return _reject(
            "explanation_length",
            f"the explanation must be between {MIN_EXPLANATION_LENGTH} and "
            f"{MAX_EXPLANATION_LENGTH} characters",
        )

    input_tokens = set(words(" ".join([task.get("title") or "", task.get("description") or ""])))
    invented = hallucinated_proper_noun(title, input_tokens)
    if invented is not None:
        return _reject(
            "hallucinated_proper_noun",
            f'the title mentions "{invented}", which is not in the assignment',
        )

    return _accept({"title": title, "explanation": explanation})


VerdictKind = Literal["breakdown", "extraction", "simplification"]


def verdict(kind: VerdictKind, raw: str, task: dict | None = None) -> dict:
    """Uniform verdict shape, used by the parity harness."""
    if kind == "breakdown":
        result = validate_breakdown(raw, task or {})
    elif kind == "extraction":
        result = validate_extraction(raw)
    else:
        result = validate_simplification(raw, task or {})
    return {
        "ok": result.ok,
        "code": result.code,
        "reason": "" if result.ok or result.rejection is None else result.rejection.reason,
    }
