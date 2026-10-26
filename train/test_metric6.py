"""Tests for metric6.py's per-row blind protocol. All synthetic, no model."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

import metric6


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def _completion(steps: list[tuple[str, int]]) -> str:
    return json.dumps(
        {
            "steps": [{"title": title, "minutes": minutes} for title, minutes in steps],
            "starterAction": steps[0][0],
        }
    )


def _make_samples(tmp_path: Path, n: int, *, duplicate_titles: bool = False):
    """n model rows and n matching-title template rows, all validator-shaped."""
    model_path = tmp_path / "model.jsonl"
    template_path = tmp_path / "templates.jsonl"

    model_rows = []
    template_rows = []
    for i in range(n):
        title = f"Assignment {i % (n // 2) if duplicate_titles else i}"
        task = {
            "title": title,
            "subject": "Test Subject",
            "description": f"description {i}" if i % 2 else None,
            "sessionMinutes": 30,
        }
        # no "model" or "template" in the content, since a test greps the row files for those words
        model_rows.append(
            {
                "kind": "breakdown",
                "task": task,
                "completion": _completion(
                    [(f"Open the notes for item {i}", 5), (f"Write the draft of item {i}", 20), (f"Read the result of item {i} aloud", 10)]
                ),
            }
        )
        template_rows.append(
            {
                "kind": "breakdown",
                "task": task,
                "completion": _completion(
                    [
                        ("Open the assignment sheet and read the prompt out loud", 5),
                        (f"Write the body of item {i}", 20),
                        ("Read it aloud and fix what sounds wrong", 10),
                    ]
                ),
            }
        )

    _write_jsonl(model_path, model_rows)
    _write_jsonl(template_path, template_rows)
    return model_path, template_path


def _build(tmp_path: Path, *, n=12, seed=7, controls=4, duplicate_titles=False) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    model_path, template_path = _make_samples(tmp_path, n, duplicate_titles=duplicate_titles)
    out_dir = tmp_path / "out"
    rows_dir = out_dir / "rows"
    key_path = out_dir / "key.json"
    rc = metric6.main(
        [
            "build",
            "--model-sample",
            str(model_path),
            "--template-sample",
            str(template_path),
            "--seed",
            str(seed),
            "--controls",
            str(controls),
            "--rows-dir",
            str(rows_dir),
            "--key",
            str(key_path),
        ]
    )
    assert rc == 0
    return out_dir


def _write_verdict(
    verdicts_dir: Path,
    row_id: str,
    *,
    startable_a=True,
    startable_b=True,
    fit="A",
    judge="test-judge",
    session="session-1",
):
    verdicts_dir.mkdir(parents=True, exist_ok=True)
    (verdicts_dir / f"{row_id}.verdict.json").write_text(
        json.dumps(
            {
                "judge": judge,
                "session": session,
                "startable_A": startable_a,
                "reason_A": "because.",
                "startable_B": startable_b,
                "reason_B": "because.",
                "fit": fit,
                "reason_fit": "because.",
            }
        ),
        encoding="utf-8",
    )


def _score(out_dir: Path, result_path: Path, *, human=False) -> dict:
    rc = metric6.main(
        [
            "score",
            "--rows-dir",
            str(out_dir / "rows"),
            "--key",
            str(out_dir / "key.json"),
            "--verdicts-dir",
            str(out_dir / "verdicts"),
            "--out",
            str(result_path),
        ]
        + (["--human"] if human else [])
    )
    assert rc == 0
    return json.loads(result_path.read_text(encoding="utf-8"))


def test_side_assignment_is_deterministic_given_a_seed(tmp_path):
    out_a = _build(tmp_path / "a", n=20, seed=123, controls=0)
    out_b = _build(tmp_path / "b", n=20, seed=123, controls=0)

    key_a = json.loads((out_a / "key.json").read_text(encoding="utf-8"))
    key_b = json.loads((out_b / "key.json").read_text(encoding="utf-8"))

    assert key_a["rows"] == key_b["rows"]


def test_side_assignment_is_not_strict_alternation(tmp_path):
    out_dir = _build(tmp_path, n=20, seed=123, controls=0)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))

    sides = [key["rows"][row_id]["model_side"] for row_id in sorted(key["rows"])]

    alternating_from_a = ["A" if i % 2 == 0 else "B" for i in range(len(sides))]
    alternating_from_b = ["B" if i % 2 == 0 else "A" for i in range(len(sides))]

    assert sides != alternating_from_a
    assert sides != alternating_from_b
    assert len(set(sides)) == 2


def test_different_seeds_give_different_assignments(tmp_path):
    out_a = _build(tmp_path / "a", n=20, seed=1, controls=0)
    out_b = _build(tmp_path / "b", n=20, seed=2, controls=0)

    key_a = json.loads((out_a / "key.json").read_text(encoding="utf-8"))
    key_b = json.loads((out_b / "key.json").read_text(encoding="utf-8"))

    assert key_a["rows"] != key_b["rows"]


def test_control_rows_excluded_from_score(tmp_path):
    out_dir = _build(tmp_path, n=12, seed=7, controls=4)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    rows = key["rows"]

    n_base = sum(1 for e in rows.values() if not e["control"])
    n_control = sum(1 for e in rows.values() if e["control"])
    assert n_control == 4
    assert n_base + n_control == len(rows)

    verdicts_dir = out_dir / "verdicts"
    for row_id, entry in rows.items():
        if entry["control"]:
            # hostile on purpose: if controls leaked into the score this would drag both sides down
            _write_verdict(verdicts_dir, row_id, startable_a=False, startable_b=False, fit="B")
        else:
            # base rows always favour the model side
            model_side = entry["model_side"]
            other = "B" if model_side == "A" else "A"
            kwargs = {
                f"startable_{model_side.lower()}": True,
                f"startable_{other.lower()}": False,
            }
            _write_verdict(verdicts_dir, row_id, fit=model_side, **kwargs)

    result = _score(out_dir, tmp_path / "result.json")

    assert result["n"] == n_base
    assert result["controls"] == n_control
    assert result["model"] == 1.0
    assert result["templates"] == 0.0
    assert result["fit_not_a_spec_metric"]["model_preferred"] == 1.0
    assert result["control_bias"]["n"] == n_control
    assert result["control_bias"]["fit_b_fraction"] == 1.0
    assert result["control_bias"]["startable_disagreement_fraction"] == 0.0


def test_score_refuses_on_missing_judge_field(tmp_path):
    out_dir = _build(tmp_path, n=6, seed=3, controls=0)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    verdicts_dir = out_dir / "verdicts"

    for row_id, entry in key["rows"].items():
        _write_verdict(verdicts_dir, row_id, fit=entry["model_side"])

    bad_row_id = next(iter(key["rows"]))
    bad_path = verdicts_dir / f"{bad_row_id}.verdict.json"
    payload = json.loads(bad_path.read_text(encoding="utf-8"))
    del payload["judge"]
    bad_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(SystemExit):
        _score(out_dir, tmp_path / "result.json")


def test_score_refuses_on_missing_verdict_file(tmp_path):
    out_dir = _build(tmp_path, n=6, seed=3, controls=0)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    verdicts_dir = out_dir / "verdicts"

    row_ids = list(key["rows"])
    for row_id in row_ids[:-1]:
        _write_verdict(verdicts_dir, row_id, fit=key["rows"][row_id]["model_side"])
    # the last row gets no verdict

    with pytest.raises(SystemExit):
        _score(out_dir, tmp_path / "result.json")


def test_score_refuses_if_key_modified_after_a_verdict(tmp_path):
    out_dir = _build(tmp_path, n=6, seed=3, controls=0)
    key_path = out_dir / "key.json"
    key = json.loads(key_path.read_text(encoding="utf-8"))
    verdicts_dir = out_dir / "verdicts"

    for row_id, entry in key["rows"].items():
        _write_verdict(verdicts_dir, row_id, fit=entry["model_side"])

    # as if someone "fixed" the side mapping after seeing the outcome
    time.sleep(0.05)
    key_path.write_text(key_path.read_text(encoding="utf-8"), encoding="utf-8")
    now = time.time() + 5
    os.utime(key_path, (now, now))

    with pytest.raises(SystemExit):
        _score(out_dir, tmp_path / "result.json")


def test_recomputation_matches_hand_computed_values(tmp_path):
    out_dir = _build(tmp_path, n=8, seed=99, controls=2)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    rows = key["rows"]
    base_ids = sorted(rid for rid, e in rows.items() if not e["control"])
    control_ids = sorted(rid for rid, e in rows.items() if e["control"])

    # controls are separate draws, so they do not subtract from the base count
    assert len(base_ids) == 8
    assert len(control_ids) == 2
    verdicts_dir = out_dir / "verdicts"

    # rows 0,1        -> model startable, other not, fit model
    # row  2          -> both startable, fit tie
    # rows 3,4,5,6,7  -> other startable, model not, fit other
    plan = {}
    for i, row_id in enumerate(base_ids):
        model_side = rows[row_id]["model_side"]
        other = "B" if model_side == "A" else "A"
        if i < 2:
            plan[row_id] = {f"startable_{model_side.lower()}": True, f"startable_{other.lower()}": False, "fit": model_side}
        elif i == 2:
            plan[row_id] = {"startable_a": True, "startable_b": True, "fit": "tie"}
        else:
            plan[row_id] = {f"startable_{model_side.lower()}": False, f"startable_{other.lower()}": True, "fit": other}
        _write_verdict(verdicts_dir, row_id, **{k: v for k, v in plan[row_id].items() if k != "fit"}, fit=plan[row_id]["fit"])

    for row_id in control_ids:
        _write_verdict(verdicts_dir, row_id, startable_a=True, startable_b=True, fit="A")

    result = _score(out_dir, tmp_path / "result.json")

    assert result["n"] == 8
    assert result["model"] == pytest.approx(3 / 8)
    assert result["templates"] == pytest.approx(6 / 8)
    assert result["fit_not_a_spec_metric"]["model_preferred"] == pytest.approx(2 / 8)
    assert result["fit_not_a_spec_metric"]["templates_preferred"] == pytest.approx(5 / 8)
    assert result["fit_not_a_spec_metric"]["tie"] == pytest.approx(1 / 8)
    assert result["control_bias"]["n"] == 2
    assert result["control_bias"]["fit_a_fraction"] == pytest.approx(1.0)
    assert result["control_bias"]["startable_disagreement_fraction"] == pytest.approx(0.0)
    assert result["judged_by"] == "test-judge, blind A/B, per-row"
    assert result["human_judged"] is False
    assert result["judge"] == "test-judge"
    assert result["session"] == "session-1"
    assert result["protocol"] == "per-row-blind-v2"
    assert result["seed"] == 99


def test_human_flag_sets_human_judged(tmp_path):
    out_dir = _build(tmp_path, n=6, seed=5, controls=0)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    verdicts_dir = out_dir / "verdicts"
    for row_id, entry in key["rows"].items():
        _write_verdict(verdicts_dir, row_id, fit=entry["model_side"], judge="a.human@example.com")

    result = _score(out_dir, tmp_path / "result.json", human=True)
    assert result["human_judged"] is True


def test_row_files_contain_no_side_identifying_keys(tmp_path):
    out_dir = _build(tmp_path, n=10, seed=11, controls=4)
    rows_dir = out_dir / "rows"
    row_files = sorted(rows_dir.glob("row-*.json"))
    assert len(row_files) > 0

    forbidden_keys = {"_model_is", "model_is", "system", "model_side", "control", "control_kind", "kind"}
    forbidden_substrings = ("model", "template")

    for path in row_files:
        raw_text = path.read_text(encoding="utf-8")
        data = json.loads(raw_text)

        assert set(data.keys()) == {"assignment", "A", "B"}, f"{path} has unexpected top-level keys"

        for side in ("A", "B"):
            assert set(data[side].keys()) == {"steps"}
            for step in data[side]["steps"]:
                assert set(step.keys()) == {"title", "minutes"}

        def _walk_keys(obj):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    yield k
                    yield from _walk_keys(v)
            elif isinstance(obj, list):
                for item in obj:
                    yield from _walk_keys(item)

        keys_found = set(_walk_keys(data))
        assert not (keys_found & forbidden_keys), f"{path} leaks a side-identifying key: {keys_found & forbidden_keys}"

        # the raw text too, in case escaping hides a key from the walk
        lowered = raw_text.lower()
        assert "_model_is" not in lowered
        for word in forbidden_substrings:
            assert word not in lowered, f"{path} contains the word '{word}' -- a possible side leak"


def test_key_file_is_the_only_place_sides_are_recorded(tmp_path):
    out_dir = _build(tmp_path, n=10, seed=11, controls=4)
    key = json.loads((out_dir / "key.json").read_text(encoding="utf-8"))
    assert "rows" in key
    sample_entry = next(iter(key["rows"].values()))
    assert "control" in sample_entry


def test_build_help_exits_zero(capsys):
    with pytest.raises(SystemExit) as excinfo:
        metric6.main(["build", "--help"])
    assert excinfo.value.code == 0


def test_score_help_exits_zero(capsys):
    with pytest.raises(SystemExit) as excinfo:
        metric6.main(["score", "--help"])
    assert excinfo.value.code == 0


def test_build_rejects_mismatched_sample_lengths(tmp_path):
    model_path, template_path = _make_samples(tmp_path, 6)
    lines = template_path.read_text(encoding="utf-8").splitlines()
    template_path.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")

    with pytest.raises(SystemExit):
        metric6.main(
            [
                "build",
                "--model-sample",
                str(model_path),
                "--template-sample",
                str(template_path),
                "--rows-dir",
                str(tmp_path / "rows"),
                "--key",
                str(tmp_path / "key.json"),
            ]
        )
