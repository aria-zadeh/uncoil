"""Tests for the pure parts of rehearse.py. No model is loaded."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import rehearse

VALID_BREAKDOWN = json.dumps(
    {
        "steps": [
            {"title": "Open the lab notebook to the titration page", "minutes": 5},
            {"title": "Copy the burette readings into a table", "minutes": 10},
            {"title": "Calculate the average titre", "minutes": 10},
            {"title": "Check the units against the lab manual", "minutes": 5},
        ],
        "starterAction": "Open the lab notebook to the titration page",
    }
)
TASK = {"title": "Lab report: titration", "subject": "Chemistry", "description": None, "duePhrase": "in 3 days", "sessionMinutes": 30}


def test_classify_model_when_first_attempt_valid():
    outcome = rehearse.classify("breakdown", TASK, VALID_BREAKDOWN, None)
    assert outcome["tier"] == "model"
    assert outcome["verdict"]["ok"] is True
    assert outcome["repair_verdict"] is None


def test_classify_repaired_when_only_the_repair_is_valid():
    outcome = rehearse.classify("breakdown", TASK, "not json at all", VALID_BREAKDOWN)
    assert outcome["tier"] == "repaired"
    assert outcome["verdict"]["ok"] is False
    assert outcome["repair_verdict"]["ok"] is True


def test_classify_template_when_both_attempts_fail():
    outcome = rehearse.classify("breakdown", TASK, "not json", "still not json")
    assert outcome["tier"] == "template"
    assert outcome["repair_verdict"]["ok"] is False


def test_classify_template_when_no_repair_was_made():
    outcome = rehearse.classify("breakdown", TASK, "not json", None)
    assert outcome["tier"] == "template"
    assert outcome["repair_verdict"] is None


def _row(id_: str, tier: str, seconds: float = 1.0, code: str | None = None) -> dict:
    return {
        "id": id_,
        "kind": "breakdown",
        "tier": tier,
        "seconds": seconds,
        "verdict": {"ok": tier == "model", "code": code, "reason": ""},
    }


def test_summarize_counts_per_prompt_and_overall():
    prompts = [{"id": "a", "kind": "breakdown", "task": {}}, {"id": "b", "kind": "breakdown", "task": {}}]
    rows = [
        _row("a", "model", 2.0),
        _row("a", "template", 4.0, code="parse_error"),
        _row("b", "repaired", 3.0, code="too_many_steps"),
        _row("b", "model", 1.0),
    ]
    summary = rehearse.summarize(rows, prompts)
    assert summary["runs"] == 4
    assert summary["model"] == 2 and summary["repaired"] == 1 and summary["template"] == 1
    assert summary["template_rate"] == 0.25
    assert summary["model_first_try_rate"] == 0.5
    assert summary["first_attempt_rejections"] == {"parse_error": 1, "too_many_steps": 1}
    assert summary["worst_prompt"] == "a"
    assert summary["per_prompt"]["a"]["template_rate"] == 0.5
    assert summary["per_prompt"]["a"]["mean_seconds"] == 3.0
    assert summary["per_prompt"]["b"]["template"] == 0


def test_summarize_handles_no_rows():
    summary = rehearse.summarize([], [{"id": "a", "kind": "breakdown", "task": {}}])
    assert summary["runs"] == 0
    assert summary["template_rate"] is None
    assert summary["per_prompt"]["a"]["runs"] == 0


def test_extraction_dump_records_only_for_prompts_with_expected():
    prompts = [
        {"id": "x", "kind": "extraction", "task": {"text": "t", "today": "Monday"}, "expected": [{"title": "quiz", "dueInDays": 2}]},
        {"id": "y", "kind": "extraction", "task": {"text": "u", "today": "Monday"}},
        {"id": "z", "kind": "breakdown", "task": {}},
    ]
    rows = [
        {"id": "x", "kind": "extraction", "task": prompts[0]["task"], "completion": '{"tasks":[{"title":"quiz","dueInDays":2}]}', "verdict": {"ok": True, "code": None, "reason": ""}, "repair_completion": None, "repair_verdict": None},
        {"id": "y", "kind": "extraction", "task": prompts[1]["task"], "completion": "{}", "verdict": {"ok": False, "code": "x", "reason": ""}, "repair_completion": None, "repair_verdict": None},
        {"id": "z", "kind": "breakdown", "task": {}, "completion": "", "verdict": {"ok": False, "code": "x", "reason": ""}, "repair_completion": None, "repair_verdict": None},
    ]
    records = rehearse.extraction_dump_records(rows, prompts)
    assert [r["task"] for r in records] == [prompts[0]["task"]]
    assert json.loads(records[0]["reference"]) == {"tasks": [{"title": "quiz", "dueInDays": 2}]}
    scored = rehearse.score_extraction.score(records)
    assert scored["task_recall"] == 1.0
    assert scored["due_exact"] == 1.0


def test_load_prompts_rejects_duplicate_ids(tmp_path: Path):
    path = tmp_path / "p.json"
    path.write_text(json.dumps([{"id": "a", "kind": "breakdown", "task": {}}, {"id": "a", "kind": "breakdown", "task": {}}]))
    with pytest.raises(SystemExit):
        rehearse.load_prompts(path)


def test_default_prompt_list_loads_and_has_both_kinds():
    prompts = rehearse.load_prompts(rehearse.DEFAULT_PROMPTS)
    kinds = {p["kind"] for p in prompts}
    assert kinds == {"breakdown", "extraction"}
    assert 8 <= len(prompts) <= 12
    for entry in prompts:
        if entry["kind"] == "extraction":
            assert entry["task"]["today"] in prompt_weekdays()
            for expected in entry.get("expected", []):
                assert 0 <= expected["dueInDays"] <= 365


def prompt_weekdays() -> set[str]:
    import prompt as prompt_mod

    return set(prompt_mod.WEEKDAYS)
