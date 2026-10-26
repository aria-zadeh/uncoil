"""Tests for score_extraction.py on tiny in-memory records shaped like eval.py --dump lines."""

from __future__ import annotations

import json
from pathlib import Path

import score_extraction as se


def _record(reference_tasks: list[dict], completion_tasks: list[dict] | None, *,
            repair_tasks: list[dict] | None = None, raw_completion: str | None = None) -> dict:
    """`completion_tasks=None` makes an unparseable completion, not an empty task list."""
    if raw_completion is not None:
        completion = raw_completion
    elif completion_tasks is None:
        completion = "not json at all"
    else:
        completion = json.dumps({"tasks": completion_tasks})

    repair_completion = json.dumps({"tasks": repair_tasks}) if repair_tasks is not None else None

    return {
        "kind": "extraction",
        "task": {"text": "irrelevant to scoring", "today": "Monday"},
        "reference": json.dumps({"tasks": reference_tasks}),
        "completion": completion,
        "repair_completion": repair_completion,
    }


def test_exact_match():
    record = _record(
        reference_tasks=[{"title": "Read chapter 4", "dueInDays": 2, "subject": "English"}],
        completion_tasks=[{"title": "Read chapter 4", "dueInDays": 2, "subject": "English"}],
    )
    metrics = se.score([record])

    assert metrics["records"] == 1
    assert metrics["unparsed"] == 0
    assert metrics["reference_tasks"] == 1
    assert metrics["predicted_tasks"] == 1
    assert metrics["matched_pairs"] == 1
    assert metrics["task_recall"] == 1.0
    assert metrics["task_precision"] == 1.0
    assert metrics["due_exact"] == 1.0
    assert metrics["due_within_1"] == 1.0
    assert metrics["due_mean_abs_error"] == 0.0
    assert metrics["subject_match"] == 1.0
    assert metrics["due_error_histogram"]["0"] == 1


def test_missed_task():
    record = _record(
        reference_tasks=[
            {"title": "Read chapter 4", "dueInDays": 2},
            {"title": "Write lab report", "dueInDays": 5},
        ],
        completion_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
    )
    metrics = se.score([record])

    assert metrics["reference_tasks"] == 2
    assert metrics["predicted_tasks"] == 1
    assert metrics["matched_pairs"] == 1
    assert metrics["task_recall"] == 0.5
    assert metrics["task_precision"] == 1.0


def test_wrong_date():
    record = _record(
        reference_tasks=[{"title": "Turn in permission slip", "dueInDays": 1}],
        completion_tasks=[{"title": "Turn in permission slip", "dueInDays": 4}],
    )
    metrics = se.score([record])

    assert metrics["matched_pairs"] == 1
    assert metrics["due_exact"] == 0.0
    assert metrics["due_within_1"] == 0.0
    assert metrics["due_mean_abs_error"] == 3.0
    assert metrics["due_error_histogram"]["2-3"] == 1
    assert metrics["due_error_histogram"]["0"] == 0


def test_unparsed_record():
    record = _record(
        reference_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
        completion_tasks=None,
    )
    metrics = se.score([record])

    assert metrics["records"] == 1
    assert metrics["unparsed"] == 1
    assert metrics["predicted_tasks"] == 0
    assert metrics["matched_pairs"] == 0
    assert metrics["task_recall"] == 0.0
    assert metrics["task_precision"] is None


def test_unparsed_completion_recovered_by_repair():
    record = _record(
        reference_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
        completion_tasks=None,
        repair_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
    )
    metrics = se.score([record])

    assert metrics["unparsed"] == 0
    assert metrics["matched_pairs"] == 1
    assert metrics["task_recall"] == 1.0


def test_empty_reference_record_correct():
    record = _record(reference_tasks=[], completion_tasks=[])
    metrics = se.score([record])

    assert metrics["empty_reference_records"] == 1
    assert metrics["empty_correct"] == 1.0
    assert metrics["reference_tasks"] == 0
    assert metrics["predicted_tasks"] == 0


def test_empty_reference_record_incorrect():
    record = _record(
        reference_tasks=[], completion_tasks=[{"title": "Invented assignment", "dueInDays": 1}]
    )
    metrics = se.score([record])

    assert metrics["empty_reference_records"] == 1
    assert metrics["empty_correct"] == 0.0
    assert metrics["predicted_tasks"] == 1
    assert metrics["matched_pairs"] == 0


def test_pools_across_records_rather_than_averaging_per_record():
    many = _record(
        reference_tasks=[
            {"title": "Read chapter 4", "dueInDays": 2},
            {"title": "Write lab report", "dueInDays": 5},
            {"title": "Turn in permission slip", "dueInDays": 1},
            {"title": "Study for the unit test", "dueInDays": 3},
        ],
        completion_tasks=[
            {"title": "Read chapter 4", "dueInDays": 2},
            {"title": "Write lab report", "dueInDays": 5},
            {"title": "Turn in permission slip", "dueInDays": 1},
            {"title": "Study for the unit test", "dueInDays": 3},
        ],
    )
    few = _record(
        reference_tasks=[{"title": "Bring signed form", "dueInDays": 1}],
        completion_tasks=[],
    )
    metrics = se.score([many, few])

    assert metrics["reference_tasks"] == 5
    assert metrics["predicted_tasks"] == 4
    assert metrics["matched_pairs"] == 4
    assert metrics["task_recall"] == 4 / 5


def test_non_extraction_records_are_ignored():
    breakdown = {"kind": "breakdown", "reference": "{}", "completion": "{}"}
    extraction = _record(
        reference_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
        completion_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
    )
    metrics = se.score([breakdown, extraction])

    assert metrics["records"] == 1
    assert metrics["matched_pairs"] == 1


def test_load_dump_reads_jsonl(tmp_path: Path):
    path = tmp_path / "dump.jsonl"
    record = _record(
        reference_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
        completion_tasks=[{"title": "Read chapter 4", "dueInDays": 2}],
    )
    path.write_text(json.dumps(record) + "\n\n", encoding="utf-8")

    records = se.load_dump(path)

    assert len(records) == 1
    assert records[0]["kind"] == "extraction"
