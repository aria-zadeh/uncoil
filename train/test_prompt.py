"""Prompt builder properties that hold whatever the parity fixtures contain."""

from __future__ import annotations

import re
from datetime import date

import pytest

import prompt as p
import sample_rft as rft


def test_system_messages_are_distinct_and_verbatim():
    assert p.SYSTEM_BREAKDOWN == (
        "Break the assignment into 3 to 7 physical steps. Respond with JSON only."
    )
    assert len({p.SYSTEM_BREAKDOWN, p.SYSTEM_EXTRACTION, p.SYSTEM_SIMPLIFY}) == 3


def test_breakdown_prompt_is_exactly_five_lines_with_no_trailing_newline():
    built = p.build_breakdown_prompt(
        p.BreakdownInput("Write an essay", "English", None, "in 3 days", 30)
    )
    assert built.user.count("\n") == 4
    assert not built.user.endswith("\n")


def test_newlines_inside_a_field_are_collapsed():
    # a raw newline would read as a new labelled line to the model
    built = p.build_breakdown_prompt(
        p.BreakdownInput("Write an essay", None, "one\ntwo\n\nthree", "in 3 days", 30)
    )
    assert built.user.count("\n") == 4
    assert "Details: one two three" in built.user


def test_absent_fields_become_none():
    built = p.build_breakdown_prompt(p.BreakdownInput("x", None, "   ", "in 3 days", 30))
    assert "Subject: none" in built.user
    assert "Details: none" in built.user


@pytest.mark.parametrize(
    "days,expected",
    [
        (-5, "today"),
        (0, "today"),
        (1, "tomorrow"),
        (2, "in 2 days"),
        (6, "in 6 days"),
        (7, "next week"),
        (8, "in 8 days"),
        (13, "in 13 days"),
        (14, "in 2 weeks"),
        (17, "in 2 weeks"),
        (21, "in 3 weeks"),
        (27, "in 3 weeks"),
        (30, "in a month"),
        (60, "in 2 months"),
    ],
)
def test_relative_due_phrase(days, expected):
    assert p.relative_due_phrase(days) == expected


def test_phrase_set_is_closed_and_never_absolute():
    # small models are bad at date arithmetic, so the model only ever sees these phrases
    pattern = re.compile(r"today|tomorrow|next week|in a month|in \d+ (days|weeks|months)")
    for days in range(-10, 400):
        assert pattern.fullmatch(p.relative_due_phrase(days))


def test_days_until_counts_calendar_days():
    assert p.days_until(date(2026, 9, 8), date(2026, 9, 7)) == 1
    assert p.days_until(date(2027, 1, 1), date(2026, 12, 30)) == 2
    assert p.days_until(date(2026, 9, 5), date(2026, 9, 7)) == -2


def test_repair_prompt_appends_the_reason_and_keeps_the_system_message():
    base = p.build_breakdown_prompt(p.BreakdownInput("x", None, None, "in 3 days", 30))
    repair = p.build_repair_prompt(base, "there were 9 steps, the maximum is 7")
    assert repair.system == base.system
    assert repair.user.startswith(base.user)
    assert repair.user.endswith("Respond again with JSON only.")


def test_chunking_never_exceeds_the_budget_and_terminates():
    for text in ["word " * 2000, "x" * 5000, "Sentence. " * 400]:
        chunks = p.chunk_for_extraction(text, 800)
        assert chunks
        for chunk in chunks:
            assert len(chunk) <= 800


def test_chunking_returns_nothing_for_empty_text():
    assert p.chunk_for_extraction("", 800) == []
    assert p.chunk_for_extraction("   \n\n  ", 800) == []


def test_extraction_prompt_is_exactly_two_lines_with_today_first():
    built = p.build_extraction_prompt("Read ch 5 by Friday", "Tuesday")
    assert built.user == "Today: Tuesday\nText: Read ch 5 by Friday"
    assert built.user.count("\n") == 1


def test_extraction_prompt_defaults_today_to_monday():
    built = p.build_extraction_prompt("Read ch 5 by Friday")
    assert built.user == "Today: Monday\nText: Read ch 5 by Friday"


def test_extraction_prompt_rejects_a_bad_weekday():
    with pytest.raises(ValueError):
        p.build_extraction_prompt("Read ch 5 by Friday", "Someday")


def test_sample_rft_parse_task_round_trips_the_two_line_form():
    built = p.build_extraction_prompt("Read ch 5 by Friday", "Wednesday")
    task = rft.parse_task("extraction", built.user)
    assert task == {"text": "Read ch 5 by Friday", "today": "Wednesday"}
    assert p.build_extraction_prompt(task["text"], task["today"]).user == built.user


def test_sample_rft_parse_task_round_trips_the_legacy_one_line_form():
    task = rft.parse_task("extraction", "Text: Read ch 5 by Friday")
    assert task == {"text": "Read ch 5 by Friday", "today": "Monday"}
    assert (
        p.build_extraction_prompt(task["text"], task["today"]).user
        == "Today: Monday\nText: Read ch 5 by Friday"
    )
