"""Tests for eval.py's --exclude handling and pure sampling helpers. No model is loaded."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch

import eval as ev


def _breakdown_record(marker: str) -> dict:
    """A distinguishable breakdown record. Never schema-valid, which is fine since these tests check counts."""
    return {
        "kind": "breakdown",
        "task": {
            "title": f"Assignment {marker}",
            "subject": "History",
            "description": None,
            "duePhrase": "in 3 days",
            "sessionMinutes": 30,
        },
        "completion": json.dumps({"steps": [{"title": "Do it", "minutes": 10}]}),
    }


def _extraction_record(marker: str) -> dict:
    return {
        "kind": "extraction",
        "task": {"text": f"Notes {marker}"},
        "completion": json.dumps({"tasks": []}),
    }


def test_load_excluded_positions_accepts_plain_int_list(tmp_path: Path):
    path = tmp_path / "excl.json"
    path.write_text(json.dumps([2, 4, 6]), encoding="utf-8")
    assert ev.load_excluded_positions(path) == {2, 4, 6}


def test_load_excluded_positions_accepts_test_id_objects(tmp_path: Path):
    """The actual shape of train/data/test-contaminated-ids.json."""
    path = tmp_path / "excl.json"
    path.write_text(
        json.dumps(
            [
                {"test_id": 2, "reason": "jaccard_prompt"},
                {"test_id": 9, "reason": "exact_prompt"},
            ]
        ),
        encoding="utf-8",
    )
    assert ev.load_excluded_positions(path) == {2, 9}


@pytest.mark.parametrize("key", ["id", "index", "position"])
def test_load_excluded_positions_accepts_other_known_keys(tmp_path: Path, key: str):
    path = tmp_path / "excl.json"
    path.write_text(json.dumps([{key: 5}, {key: 7}]), encoding="utf-8")
    assert ev.load_excluded_positions(path) == {5, 7}


def test_load_excluded_positions_rejects_object_with_no_known_key(tmp_path: Path):
    path = tmp_path / "excl.json"
    path.write_text(json.dumps([{"reason": "jaccard_prompt"}]), encoding="utf-8")
    with pytest.raises(SystemExit):
        ev.load_excluded_positions(path)


def test_load_excluded_positions_rejects_non_list_json(tmp_path: Path):
    path = tmp_path / "excl.json"
    path.write_text(json.dumps({"not": "a list"}), encoding="utf-8")
    with pytest.raises(SystemExit):
        ev.load_excluded_positions(path)


def _fake_split() -> list[dict]:
    return [
        _breakdown_record("A"),   # 0
        _extraction_record("B"),  # 1
        _breakdown_record("C"),   # 2
        _breakdown_record("D"),   # 3
        _extraction_record("E"),  # 4
        _breakdown_record("F"),   # 5
    ]


def test_exclusion_drops_exactly_the_named_positions():
    records_all = _fake_split()
    records, keep, kfp, excluded_count = ev.select_records(
        records_all, exclude_positions={1, 3}
    )
    assert excluded_count == 2
    assert keep == [0, 2, 4, 5]
    # pure selection with no reordering, so every other record keeps its per-prompt seed
    assert records == [records_all[i] for i in [0, 2, 4, 5]]
    markers = [
        r["task"]["title"] if r["kind"] == "breakdown" else r["task"]["text"] for r in records
    ]
    assert markers == ["Assignment A", "Assignment C", "Notes E", "Assignment F"]


def test_exclusion_combines_with_kinds_filter():
    records_all = _fake_split()
    # breakdowns sit at 0, 2, 3, 5. position 1 is an extraction
    records, keep, kfp, excluded_count = ev.select_records(
        records_all, kinds="breakdown", exclude_positions={1, 3}
    )
    assert kfp == [0, 2, 3, 5]
    assert excluded_count == 1  # only position 3 was both breakdown and excluded
    assert keep == [0, 2, 5]
    assert all(r["kind"] == "breakdown" for r in records)
    assert [r["task"]["title"] for r in records] == [
        "Assignment A",
        "Assignment C",
        "Assignment F",
    ]


def test_exclusion_applies_before_limit():
    records_all = _fake_split()
    records, keep, kfp, excluded_count = ev.select_records(
        records_all, exclude_positions={0}, limit=2
    )
    # limit applies after exclusion, not before
    assert keep == [1, 2]
    assert excluded_count == 1


def test_no_exclusion_is_a_no_op():
    records_all = _fake_split()
    records, keep, kfp, excluded_count = ev.select_records(records_all)
    assert excluded_count == 0
    assert keep == list(range(len(records_all)))
    assert records == records_all


def test_score_denominators_shrink_with_exclusion():
    records_all = [_breakdown_record(m) for m in "ABCDEF"]

    def run(exclude_positions: set[int]) -> dict:
        records, keep, kfp, _ = ev.select_records(
            records_all, kinds="breakdown", exclude_positions=exclude_positions
        )
        predictions = [""] * len(records)  # empty output: fails validation uniformly
        repairs: list[str | None] = [None] * len(records)
        return ev.score(records, predictions, repairs)

    full = run(set())
    assert full["n"] == 6
    assert full["n_breakdown"] == 6

    excluded = run({1, 4})
    assert excluded["n"] == 4
    assert excluded["n_all"] == 4
    assert excluded["n_breakdown"] == 4
    assert excluded["1_schema_first_try"] == full["1_schema_first_try"]  # 0/n both times
    assert excluded["rejection_reasons"]["empty_output"] == 4
    assert full["rejection_reasons"]["empty_output"] == 6


def test_top_p_filter_keeps_top_token_and_respects_cumulative_mass():
    # softmax(log(p)) == p, so these carry exact probabilities. cumulative mass 0.4, 0.7, 0.9, 1.0
    logits = torch.log(torch.tensor([0.4, 0.3, 0.2, 0.1]))

    # the smallest prefix reaching 0.75 is the first three tokens
    filtered = ev.top_p_filter(logits, top_p=0.75)
    assert torch.isfinite(filtered[:3]).all()
    assert filtered[3] == float("-inf")

    # the top token survives even when it alone overshoots top_p
    filtered_tiny = ev.top_p_filter(logits, top_p=0.01)
    assert torch.isfinite(filtered_tiny[0])
    assert torch.isinf(filtered_tiny[1:]).all()


def test_sample_token_greedy_returns_argmax():
    logits = torch.tensor([1.0, 5.0, 3.0, -2.0])
    # values that would matter under sampling, to show greedy ignores them
    for _ in range(5):
        assert ev.sample_token(logits, temperature=0.3, top_p=0.9, greedy=True) == 1


def test_score_n_all_and_n_breakdown_diverge_on_a_mixed_split():
    """Both denominators are reported, so a reader can tell which one a metric used."""
    records = [_breakdown_record("A"), _breakdown_record("B"), _extraction_record("C")]
    predictions = [""] * 3
    repairs: list[str | None] = [None] * 3
    metrics = ev.score(records, predictions, repairs)
    assert metrics["n"] == metrics["n_all"] == 3
    assert metrics["n_breakdown"] == 2
    assert metrics["n_all"] != metrics["n_breakdown"]
