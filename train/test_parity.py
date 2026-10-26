"""Tests for parity.py's pure logic. Runs under train/.venv, which has no executorch, so nothing here may import it."""

from __future__ import annotations

import json
from pathlib import Path

import parity


def test_metadata_path_for_default_artifact_name(tmp_path: Path):
    pte = tmp_path / parity.export_mod.ARTIFACT_NAME
    assert parity.metadata_path_for(pte) == tmp_path / "export-metadata.json"


def test_metadata_path_for_custom_out_name(tmp_path: Path):
    pte = tmp_path / "tether-135m-8da4w-hostparity.pte"
    assert parity.metadata_path_for(pte) == tmp_path / "export-metadata-tether-135m-8da4w-hostparity.json"


def test_load_export_metadata_reads_the_json_beside_the_pte(tmp_path: Path):
    pte = tmp_path / parity.export_mod.ARTIFACT_NAME
    pte.write_bytes(b"not a real pte")
    recipe = {
        "qlinear": "8da4w",
        "qembedding": "4w",
        "dtype": None,
        "max_seq_len": 1024,
        "model": "train/out/v1/best",
        "generated_at": "2026-09-06T00:00:00Z",
    }
    (tmp_path / "export-metadata.json").write_text(json.dumps(recipe), encoding="utf-8")

    assert parity.load_export_metadata(pte) == recipe


def test_load_export_metadata_returns_none_when_missing(tmp_path: Path):
    pte = tmp_path / parity.export_mod.ARTIFACT_NAME
    pte.write_bytes(b"not a real pte")
    assert parity.load_export_metadata(pte) is None


def test_load_export_metadata_returns_none_on_bad_json(tmp_path: Path):
    pte = tmp_path / parity.export_mod.ARTIFACT_NAME
    pte.write_bytes(b"not a real pte")
    (tmp_path / "export-metadata.json").write_text("{not json", encoding="utf-8")
    assert parity.load_export_metadata(pte) is None


def test_matched_recipe_is_identical_to_fp32_for_no_quantization():
    assert parity.matched_recipe_is_identical_to_fp32({"qlinear": None, "qembedding": None, "dtype": None})
    assert parity.matched_recipe_is_identical_to_fp32({"qlinear": "", "qembedding": None, "dtype": "float32"})


def test_matched_recipe_is_identical_to_fp32_false_for_qlinear():
    assert not parity.matched_recipe_is_identical_to_fp32({"qlinear": "8da4w", "qembedding": "4w", "dtype": None})


def test_matched_recipe_is_identical_to_fp32_false_for_bfloat16():
    assert not parity.matched_recipe_is_identical_to_fp32({"qlinear": None, "qembedding": None, "dtype": "bfloat16"})


def test_exact_match_fraction():
    assert parity.exact_match_fraction(["a", "b", "c"], ["a", "x", "c"]) == 2 / 3


def _metrics(**overrides) -> dict:
    base = {key: 1.0 for key in parity.COMPARED_METRICS}
    base.update(overrides)
    return base


def test_evaluate_gate_passes_when_everything_within_tolerance():
    hf_metrics = _metrics()
    et_metrics = _metrics()
    gate = parity.evaluate_gate(hf_metrics, et_metrics, exact=0.9)
    assert gate["failures"] == 0
    assert all(row["passed"] for row in gate["rows"])


def test_evaluate_gate_counts_schema_validity_and_metric_row_separately():
    # 1_schema_first_try is checked against both tolerances, so one 0.05 gap fails two rows
    hf_metrics = _metrics(**{"1_schema_first_try": 1.0})
    et_metrics = _metrics(**{"1_schema_first_try": 0.95})
    gate = parity.evaluate_gate(hf_metrics, et_metrics, exact=0.9)
    assert gate["failures"] == 2
    names_failed = {row["name"] for row in gate["rows"] if not row["passed"]}
    assert names_failed == {"schema validity", "1_schema_first_try"}


def test_evaluate_gate_reports_exact_match_below_minimum_without_counting_it():
    gate = parity.evaluate_gate(_metrics(), _metrics(), exact=parity.MIN_EXACT_MATCH - 0.01)
    assert gate["failures"] == 0
    row = next(r for r in gate["rows"] if r["name"] == "exact string match")
    assert not row["passed"]
    assert row["note"] == "(reported, not gated; DECISIONS.md 2026-09-07)"


def _fake_artifact() -> dict:
    return {"file_name": "tether-135m-8da4w.pte", "sha256": "deadbeef", "bytes": 123, "host_parity": False}


def _fake_agreement() -> dict:
    return parity.teacher_forced_agreement([([1, 2, 3], [1, 2, 3])])


def _fake_agreement_below_floor() -> dict:
    # 9 of 10 agree, under the 0.95 floor
    result = parity.teacher_forced_agreement([([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 0])])
    assert result["teacher_forced_top1_agreement"] < parity.MIN_TEACHER_FORCED_AGREEMENT
    return result


_MATCHED_METADATA = {"qlinear": "8da4w", "qembedding": "4w", "dtype": None, "max_seq_len": 1024, "model": "m", "generated_at": "t"}


def _report(*, reference: str, gate_fp32: dict, gate_matched: dict | None, tf_fp32: dict, tf_matched: dict | None) -> dict:
    matched = gate_matched is not None
    return parity.build_report(
        prompts_count=100,
        runtime="optimum.executorch ExecuTorchModelForCausalLM",
        artifact=_fake_artifact(),
        metadata=_MATCHED_METADATA if matched else None,
        reference=reference,
        gate_fp32=gate_fp32,
        exact_fp32=0.2,
        hf_metrics=_metrics(),
        et_metrics=_metrics(),
        gate_matched=gate_matched,
        matched_metrics=_metrics() if matched else None,
        exact_matched=0.2 if matched else None,
        matched_identical_to_fp32=False if matched else None,
        tf_agreement_fp32=tf_fp32,
        tf_agreement_matched=tf_matched,
    )


def test_build_report_gates_on_fp32_when_matched_did_not_run():
    passing_gate = {"rows": [], "failures": 0}
    failing_gate = {"rows": [], "failures": 3}

    report_pass = _report(reference="fp32", gate_fp32=passing_gate, gate_matched=None, tf_fp32=_fake_agreement(), tf_matched=None)
    assert report_pass["passed"] is True
    assert report_pass["gated_on"] == "fp32"

    report_fail = _report(reference="fp32", gate_fp32=failing_gate, gate_matched=None, tf_fp32=_fake_agreement(), tf_matched=None)
    assert report_fail["passed"] is False
    assert report_fail["gate"]["structural_failures"] == 3

    report_low_agreement = _report(
        reference="fp32", gate_fp32=passing_gate, gate_matched=None, tf_fp32=_fake_agreement_below_floor(), tf_matched=None
    )
    assert report_low_agreement["passed"] is False
    assert report_low_agreement["gate"]["agreement_passed"] is False


def test_build_report_gates_on_matched_when_it_ran():
    passing_gate = {"rows": [], "failures": 0}
    failing_gate = {"rows": [], "failures": 3}

    report_pass = _report(
        reference="matched", gate_fp32=failing_gate, gate_matched=passing_gate, tf_fp32=_fake_agreement_below_floor(), tf_matched=_fake_agreement()
    )
    assert report_pass["passed"] is True
    assert report_pass["gated_on"] == "matched"
    assert report_pass["gate"]["reference"] == "matched"

    report_fail = _report(
        reference="matched", gate_fp32=passing_gate, gate_matched=failing_gate, tf_fp32=_fake_agreement(), tf_matched=_fake_agreement()
    )
    assert report_fail["passed"] is False
    assert report_fail["gate"]["structural_failures"] == 3

    report_low_agreement = _report(
        reference="matched", gate_fp32=passing_gate, gate_matched=passing_gate, tf_fp32=_fake_agreement(), tf_matched=_fake_agreement_below_floor()
    )
    assert report_low_agreement["passed"] is False
    assert report_low_agreement["gate"]["agreement_passed"] is False
    assert report_low_agreement["gate"]["teacher_forced_top1_agreement"] == 0.9


def test_build_report_key_shape_fp32_only():
    gate = {"rows": [{"name": "exact string match"}], "failures": 0}
    report = parity.build_report(
        prompts_count=30,
        runtime="optimum.executorch ExecuTorchModelForCausalLM",
        artifact=_fake_artifact(),
        metadata=None,
        reference="fp32",
        gate_fp32=gate,
        exact_fp32=0.87,
        hf_metrics=_metrics(),
        et_metrics=_metrics(),
        gate_matched=None,
        matched_metrics=None,
        exact_matched=None,
        matched_identical_to_fp32=None,
        tf_agreement_fp32=_fake_agreement(),
        tf_agreement_matched=None,
    )

    # older keys that scripts/verify/artifact.mjs still reads
    assert report["passed"] is True
    assert report["artifact"] == _fake_artifact()
    assert report["exact_match"] == 0.87
    assert report["huggingface"] == _metrics()
    assert report["executorch"] == _metrics()

    assert report["gated_on"] == "fp32"
    assert report["gate"]["reference"] == "fp32"
    assert report["gate"]["min_teacher_forced_top1_agreement"] == parity.MIN_TEACHER_FORCED_AGREEMENT
    assert report["gate"]["exact_match_gated"] is False
    assert report["export_recipe"] is None
    assert report["reference"] == "fp32"
    assert report["exact_match_vs_fp32"] == 0.87
    assert report["exact_match_vs_matched"] is None
    assert report["metrics_vs_fp32"] == {"huggingface": _metrics(), "executorch": _metrics()}
    assert report["metrics_vs_matched"] is None
    assert report["gate_rows_vs_fp32"] == gate["rows"]
    assert report["gate_rows_vs_matched"] is None
    assert report["matched_recipe_identical_to_fp32"] is None
    assert report["teacher_forced_top1_agreement_vs_fp32"] == _fake_agreement()
    assert report["teacher_forced_top1_agreement_vs_matched"] is None


def test_build_report_key_shape_with_matched():
    gate_fp32 = {"rows": [{"name": "exact string match"}], "failures": 0}
    gate_matched = {"rows": [{"name": "exact string match"}], "failures": 1}
    metadata = {"qlinear": "8da4w", "qembedding": "4w", "dtype": None, "max_seq_len": 1024, "model": "m", "generated_at": "t"}
    matched_metrics = _metrics(**{"1_schema_first_try": 0.5})

    report = parity.build_report(
        prompts_count=30,
        runtime="optimum.executorch ExecuTorchModelForCausalLM",
        artifact=_fake_artifact(),
        metadata=metadata,
        reference="matched",
        gate_fp32=gate_fp32,
        exact_fp32=0.87,
        hf_metrics=_metrics(),
        et_metrics=_metrics(),
        gate_matched=gate_matched,
        matched_metrics=matched_metrics,
        exact_matched=0.5,
        matched_identical_to_fp32=False,
        tf_agreement_fp32=_fake_agreement(),
        tf_agreement_matched=_fake_agreement(),
    )

    assert report["reference"] == "matched"
    assert report["export_recipe"] == metadata
    assert report["exact_match_vs_matched"] == 0.5
    assert report["metrics_vs_matched"] == {"huggingface": matched_metrics, "executorch": _metrics()}
    assert report["gate_rows_vs_matched"] == gate_matched["rows"]
    assert report["matched_recipe_identical_to_fp32"] is False
    assert report["teacher_forced_top1_agreement_vs_matched"] == _fake_agreement()
    assert report["gated_on"] == "matched"
    assert report["passed"] is False
    assert report["gate"]["structural_failures"] == 1
    assert report["gate"]["exact_match_gated"] is False


def test_teacher_forced_agreement_perfect_match():
    result = parity.teacher_forced_agreement([([1, 2, 3], [1, 2, 3])])
    assert result["teacher_forced_top1_agreement"] == 1.0
    assert result["completion_positions_compared"] == 3
    assert result["prompts_compared"] == 1
    # no divergence, so the index is the sequence length
    assert result["first_divergence_index"] == {"median": 3, "min": 3}


def test_teacher_forced_agreement_diverges_at_known_index():
    # A diverges at index 1, B at index 0
    pairs = [
        ([1, 2, 3], [1, 9, 3]),
        ([5, 6], [9, 6]),
    ]
    result = parity.teacher_forced_agreement(pairs)
    # pooled: A agrees at 2 of 3 positions, B at 1 of 2, so 3 of 5
    assert result["completion_positions_compared"] == 5
    assert result["teacher_forced_top1_agreement"] == 3 / 5
    assert result["prompts_compared"] == 2
    assert result["first_divergence_index"] == {"median": 0.5, "min": 0}


def test_teacher_forced_agreement_skips_empty_pairs():
    result = parity.teacher_forced_agreement([([], []), ([1], [1])])
    assert result["completion_positions_compared"] == 1
    assert result["prompts_compared"] == 1
    assert result["teacher_forced_top1_agreement"] == 1.0


def test_teacher_forced_agreement_handles_no_pairs():
    result = parity.teacher_forced_agreement([])
    assert result["teacher_forced_top1_agreement"] is None
    assert result["completion_positions_compared"] == 0
    assert result["prompts_compared"] == 0
    assert result["first_divergence_index"] == {"median": None, "min": None}


def test_teacher_forced_agreement_uneven_sequence_lengths_compares_the_overlap():
    # should never happen for the same full_ids, but must compare the overlap rather than crash
    result = parity.teacher_forced_agreement([([1, 2, 3, 4], [1, 2])])
    assert result["completion_positions_compared"] == 2
    assert result["teacher_forced_top1_agreement"] == 1.0
