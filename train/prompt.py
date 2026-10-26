"""Prompt construction. Must emit byte-identical strings to services/prompt.ts, or training drifts from inference."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

# verbatim from services/prompt.ts
SYSTEM_BREAKDOWN = "Break the assignment into 3 to 7 physical steps. Respond with JSON only."
SYSTEM_EXTRACTION = "Find the assignments and their due dates in the text. Respond with JSON only."
SYSTEM_SIMPLIFY = "Rewrite the assignment in plainer words for a sixth-grade reader. Respond with JSON only."

NONE = "none"

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Prompt:
    system: str
    user: str


@dataclass(frozen=True)
class BreakdownInput:
    title: str
    subject: str | None
    description: str | None
    due_phrase: str
    session_minutes: int


@dataclass(frozen=True)
class SimplifyInput:
    title: str
    description: str | None


def days_until(due: date, now: date) -> int:
    """Whole calendar days between two dates, matching daysUntil in prompt.ts."""
    return (due - now).days


def relative_due_phrase(days: int) -> str:
    """Mirrors relativeDuePhrase in prompt.ts. Closed, because the model only trained on these phrases."""
    if days <= 0:
        return "today"
    if days == 1:
        return "tomorrow"
    if days == 7:
        return "next week"
    if days == 14:
        return "in 2 weeks"
    if days < 14:
        return f"in {days} days"
    if days < 21:
        return "in 2 weeks"
    if days < 28:
        return "in 3 weeks"
    months = round(days / 30)
    return "in a month" if months <= 1 else f"in {months} months"


def field(value: str | None) -> str:
    """Collapse whitespace, since a raw newline would break the one-line-per-field record."""
    if value is None:
        return NONE
    cleaned = _WHITESPACE.sub(" ", value).strip()
    return NONE if cleaned == "" else cleaned


def build_breakdown_prompt(task: BreakdownInput) -> Prompt:
    user = "\n".join(
        [
            f"Assignment: {field(task.title)}",
            f"Subject: {field(task.subject)}",
            f"Details: {field(task.description)}",
            f"Due: {field(task.due_phrase)}",
            f"Session length: {task.session_minutes}",
        ]
    )
    return Prompt(system=SYSTEM_BREAKDOWN, user=user)


def build_extraction_prompt(chunk: str, today: str = "Monday") -> Prompt:
    if today not in WEEKDAYS:
        raise ValueError(f"today must be a weekday name, got {today!r}")
    # without a reference day, the same "due Friday" got labelled with different counts
    user = f"Today: {today}\nText: {field(chunk)}"
    return Prompt(system=SYSTEM_EXTRACTION, user=user)


def build_simplify_prompt(task: SimplifyInput) -> Prompt:
    user = "\n".join(
        [
            f"Assignment: {field(task.title)}",
            f"Details: {field(task.description)}",
        ]
    )
    return Prompt(system=SYSTEM_SIMPLIFY, user=user)


def build_repair_prompt(original: Prompt, reason: str) -> Prompt:
    """The app's one retry after a rejection."""
    return Prompt(
        system=original.system,
        user=f"{original.user}\n\nRejected: {reason}. Respond again with JSON only.",
    )


def chunk_for_extraction(text: str, max_chars: int) -> list[str]:
    """Split on paragraphs, then sentences, then hard. Never emits an oversized chunk."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() != ""]
    chunks: list[str] = []
    current = ""

    def push() -> None:
        nonlocal current
        if current.strip() != "":
            chunks.append(current.strip())
        current = ""

    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            push()
            for sentence in re.split(r"(?<=[.!?])\s+", paragraph):
                rest = sentence
                while len(rest) > max_chars:
                    chunks.append(rest[:max_chars].strip())
                    rest = rest[max_chars:]
                if len(current) + len(rest) + 1 > max_chars:
                    push()
                current = rest if current == "" else f"{current} {rest}"
            push()
            continue
        if len(current) + len(paragraph) + 2 > max_chars:
            push()
        current = paragraph if current == "" else f"{current}\n\n{paragraph}"

    push()
    return chunks
