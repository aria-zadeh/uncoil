"""Due-date resolver tests. The JSON fixtures are shared with services/dueDates.ts."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

import due_dates as dd

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = REPO_ROOT / "__tests__" / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


PHRASE_CASES = _load("due-phrases.json")["cases"]
RECONCILE_CASES = _load("due-reconcile.json")["cases"]


def _case_id(case: dict, index: int) -> str:
    label = case.get("phrase") or case.get("name") or ""
    return f"{index}-{label}"[:60]


@pytest.mark.parametrize(
    "case", PHRASE_CASES, ids=[_case_id(c, i) for i, c in enumerate(PHRASE_CASES)]
)
def test_resolve_due_phrase_fixture(case: dict) -> None:
    today_date = date.fromisoformat(case["todayDate"]) if case.get("todayDate") else None
    got = dd.resolve_due_phrase(case["phrase"], case["today"], case["lastDue"], today_date)
    assert got == case["expected"]


@pytest.mark.parametrize(
    "case", RECONCILE_CASES, ids=[_case_id(c, i) for i, c in enumerate(RECONCILE_CASES)]
)
def test_reconcile_due_dates_fixture(case: dict) -> None:
    today_date = date.fromisoformat(case["todayDate"]) if case.get("todayDate") else None
    last_due = case.get("lastDue")
    got = dd.reconcile_due_dates(case["tasks"], case["text"], case["today"], today_date, last_due)
    assert got == case["expected"]


class TestFixtureCorpus:
    """A fixture corpus that shrank or lost its edge cases would silently weaken parity for both ports."""

    def test_phrase_fixture_is_non_trivial(self):
        assert len(PHRASE_CASES) >= 40

    def test_reconcile_fixture_is_non_trivial(self):
        assert len(RECONCILE_CASES) >= 8

    def test_phrase_fixture_covers_null_results(self):
        assert any(c["expected"] is None for c in PHRASE_CASES)

    def test_reconcile_fixture_covers_both_sources(self):
        sources = {t["dueSource"] for c in RECONCILE_CASES for t in c["expected"]}
        assert sources == {"text", "model"}


class TestFindDuePhrasesLongestMatch:
    """Longest match wins at a position, so a phrase is found whole."""

    def test_next_weekday_beats_bare_weekday(self):
        found = dd.find_due_phrases("Quiz due next Tuesday in class.")
        assert [p for p, _ in found] == ["next Tuesday"]

    def test_following_weekday_beats_bare_weekday(self):
        found = dd.find_due_phrases("Project due the following Monday.")
        assert [p for p, _ in found] == ["the following Monday"]

    def test_day_after_tomorrow_beats_tomorrow(self):
        found = dd.find_due_phrases("Essay due the day after tomorrow.")
        assert [p for p, _ in found] == ["the day after tomorrow"]

    def test_in_two_weeks_beats_bare_week(self):
        found = dd.find_due_phrases("Test in two weeks.")
        assert [p for p, _ in found] == ["in two weeks"]

    def test_full_weekday_name_beats_its_own_abbreviation(self):
        # the (?![a-zA-Z]) guard, not fragment order, is what stops "Fri" matching inside "Friday"
        found = dd.find_due_phrases("Quiz due Friday.")
        assert [p for p, _ in found] == ["Friday"]

    def test_weekday_plus_calendar_date_is_one_phrase(self):
        found = dd.find_due_phrases("Project due Friday the 25th.")
        assert [p for p, _ in found] == ["Friday the 25th"]

    def test_multiple_phrases_found_in_order(self):
        found = dd.find_due_phrases(
            "The lab report is due Wednesday and the problem set is due next Monday."
        )
        phrases = [p for p, _ in found]
        assert phrases == ["Wednesday", "next Monday"]
        indices = [i for _, i in found]
        assert indices == sorted(indices)

    def test_weekday_label_at_sentence_start_is_a_phrase(self):
        assert dd.find_due_phrases("Monday: quiz on chapters.") == [("Monday", 0)]

    def test_no_recognised_phrase_returns_empty(self):
        assert dd.find_due_phrases("Bring your signed permission slip.") == []


class TestSplitSentences:
    """Split on sentence punctuation and a spaced dash, and peel a leading weekday label into its own sentence."""

    def test_splits_on_period_question_and_exclamation(self):
        assert dd.split_sentences("Quiz Friday. Read chapter 4! Any questions?") == [
            "Quiz Friday.",
            "Read chapter 4!",
            "Any questions?",
        ]

    def test_splits_on_semicolon_and_newline(self):
        assert dd.split_sentences("Quiz Friday; test next week\nEssay due Monday") == [
            "Quiz Friday",
            "test next week",
            "Essay due Monday",
        ]

    def test_splits_before_a_colon_label_with_no_other_punctuation(self):
        text = "Monday quiz due Wednesday lab due"
        assert dd.split_sentences(text) == [text]

    def test_weekday_colon_label_becomes_its_own_sentence(self):
        assert dd.split_sentences("Monday: quiz due. Wednesday: lab due.") == [
            "Monday",
            "quiz due.",
            "Wednesday",
            "lab due.",
        ]

    def test_spaced_dash_is_a_generic_item_separator(self):
        assert dd.split_sentences("Mon - practice due Wed - review due") == [
            "Mon",
            "practice due Wed",
            "review due",
        ]

    def test_weekday_before_dash_mid_segment_is_not_a_label(self):
        assert dd.split_sentences(
            "lit essay due monday - permission slip due wednesday"
        ) == ["lit essay due monday", "permission slip due wednesday"]

    def test_next_and_the_following_weekday_dash_label_at_a_segment_start(self):
        assert dd.split_sentences("Fri - quiz due. Next Mon - study guide due.") == [
            "Fri",
            "quiz due.",
            "Next Mon",
            "study guide due.",
        ]
        assert dd.split_sentences("The following Mon - unit 6 study guide due.") == [
            "The following Mon",
            "unit 6 study guide due.",
        ]

    def test_splits_before_en_dash_and_em_dash_labels(self):
        assert dd.split_sentences("Mon – practice due. Tue — review due.") == [
            "Mon",
            "practice due.",
            "Tue",
            "review due.",
        ]

    def test_empty_and_whitespace_only_text_yields_no_sentences(self):
        assert dd.split_sentences("") == []
        assert dd.split_sentences("   \n  ") == []


class TestLastDueOf:
    def test_none_when_no_task_is_sourced_from_text(self):
        tasks = [{"title": "x", "dueInDays": 2, "dueSource": "model"}]
        assert dd.last_due_of(tasks) is None

    def test_returns_the_last_text_sourced_due_in_days(self):
        tasks = [
            {"title": "a", "dueInDays": 2, "dueSource": "text"},
            {"title": "b", "dueInDays": 9, "dueSource": "model"},
            {"title": "c", "dueInDays": 5, "dueSource": "text"},
            {"title": "d", "dueInDays": 3, "dueSource": "model"},
        ]
        assert dd.last_due_of(tasks) == 5

    def test_empty_task_list_is_none(self):
        assert dd.last_due_of([]) is None


class TestReconcileDueDatesEdgeCases:
    def test_empty_task_list_returns_empty_list(self):
        assert dd.reconcile_due_dates([], "Quiz due Friday.", "Monday") == []

    def test_invalid_today_raises(self):
        with pytest.raises(ValueError):
            dd.resolve_due_phrase("Friday", "Someday", None)
