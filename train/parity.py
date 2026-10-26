"""Host parity between the merged checkpoint and the exported .pte, required before an artifact ships. A failure is an export bug; never tune the model to compensate."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export as export_mod
import prompt as prompt_mod
import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
TEST_SOURCE = TRAIN_DIR / "data_sources" / "test"
REPORT_DIR = TRAIN_DIR / "reports"
DEFAULT_REPORT_PATH = REPORT_DIR / "parity.json"

PROMPT_COUNT = 100
MAX_NEW_TOKENS = 320

VALIDITY_TOLERANCE = 0.02
METRIC_TOLERANCE = 0.03
# exact match is reported, not gated: one argmax flip breaks the string, and no int8 or bf16
# export reaches 0.70. a broken kernel disagrees on most positions, quantization noise on a few
MIN_EXACT_MATCH = 0.70
MIN_TEACHER_FORCED_AGREEMENT = 0.95

COMPARED_METRICS = (
    "1_schema_first_try",
    "3_step_count_in_range",
    "4_steps_under_45_min",
    "5_actionability",
    "7_hallucination",
    "9_format_leakage",
    "10_repetition",
)


def fixed_prompts() -> list[dict]:
    """The same hundred prompts every run, spaced through the sealed test split. Reports from the older thirty-prompt set compare only by metric rows."""
    records: list[dict] = []
    for path in sorted(TEST_SOURCE.glob("*.json")):
        records.extend(json.loads(path.read_text(encoding="utf-8")))
    if len(records) < PROMPT_COUNT:
        raise SystemExit(f"need {PROMPT_COUNT} test records, found {len(records)}")

    # evenly spaced so the prompts span every kind and length, not whichever batch sorts first
    stride = max(1, len(records) // PROMPT_COUNT)
    return [records[i * stride] for i in range(PROMPT_COUNT)]


def build(record: dict) -> prompt_mod.Prompt:
    task = record["task"]
    if record["kind"] == "breakdown":
        return prompt_mod.build_breakdown_prompt(
            prompt_mod.BreakdownInput(
                title=task.get("title", ""),
                subject=task.get("subject"),
                description=task.get("description"),
                due_phrase=task.get("duePhrase", "in 3 days"),
                session_minutes=task.get("sessionMinutes", 30),
            )
        )
    if record["kind"] == "extraction":
        return prompt_mod.build_extraction_prompt(task.get("text", ""), task.get("today", "Monday"))
    return prompt_mod.build_simplify_prompt(
        prompt_mod.SimplifyInput(title=task.get("title", ""), description=task.get("description"))
    )


def metadata_path_for(pte: Path) -> Path:
    """Where export.py writes the recipe beside an artifact, named like its export-report*.json."""
    name = (
        "export-metadata.json"
        if pte.name == export_mod.ARTIFACT_NAME
        else f"export-metadata-{pte.stem}.json"
    )
    return pte.parent / name


def load_export_metadata(pte: Path) -> dict | None:
    """The recipe export.py recorded for this artifact, or None. Only --reference matched needs one."""
    path = metadata_path_for(pte)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def matched_recipe_is_identical_to_fp32(recipe: dict) -> bool:
    """No integer quantization and no reduced dtype, so the matched reference is just fp32 again."""
    qlinear = recipe.get("qlinear")
    dtype = recipe.get("dtype")
    return not qlinear and dtype in (None, "float32")


class HuggingFaceRunner:
    """The merged checkpoint at full precision, the fp32 reference."""

    def __init__(self, model_path: Path) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path))
        self.model = AutoModelForCausalLM.from_pretrained(str(model_path), dtype=torch.float32)
        self.model.eval()

    def _chat_text(self, built: prompt_mod.Prompt) -> str:
        return self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": built.system},
                {"role": "user", "content": built.user},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )

    def generate(self, built: prompt_mod.Prompt) -> str:
        text = self._chat_text(built)
        inputs = self.tokenizer(text, return_tensors="pt")
        # greedy on both sides, so exact match measures the implementations rather than a seed
        with self.torch.no_grad():
            out = self.model.generate(
                **inputs,
                max_new_tokens=MAX_NEW_TOKENS,
                do_sample=False,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        return self.tokenizer.decode(
            out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True
        )


class MatchedHuggingFaceRunner(HuggingFaceRunner):
    """The fp32 checkpoint with the exporter's own quantization reapplied in eager PyTorch, or a bfloat16 load for a dtype-only recipe."""

    def __init__(self, model_path: Path, recipe: dict) -> None:  # noqa: super-not-called
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path))

        qlinear = recipe.get("qlinear")
        qembedding = recipe.get("qembedding")
        dtype = recipe.get("dtype")

        if qlinear in ("8da4w", "8da8w"):
            # the exporter calls quantize_model_ with exactly these arguments and leaves the rest default
            from optimum.exporters.executorch.quantization import (  # type: ignore[import-not-found]
                quantize_model_,
            )

            self.model = AutoModelForCausalLM.from_pretrained(str(model_path), dtype=torch.float32)
            self.model.eval()
            quantize_model_(self.model, qlinear_config=qlinear, qembedding_config=qembedding)
        elif dtype == "bfloat16":
            self.model = AutoModelForCausalLM.from_pretrained(str(model_path), dtype=torch.bfloat16)
            self.model.eval()
        else:
            # neither, so fp32. only reachable when built without the identical-to-fp32 check
            self.model = AutoModelForCausalLM.from_pretrained(str(model_path), dtype=torch.float32)
            self.model.eval()


class ExecuTorchRunner:
    """The exported program through ExecuTorch's host runtime. Entry points differ by version, so the working one is reported."""

    def __init__(self, pte: Path, model_path: Path) -> None:
        self.pte = pte
        self.method = ""
        self.runner = None

        try:
            from optimum.executorch import ExecuTorchModelForCausalLM  # type: ignore[import-not-found]
            from transformers import AutoTokenizer

            self.tokenizer = AutoTokenizer.from_pretrained(str(model_path))

            # from_pretrained keys every .pte in the directory by file name, so a second one
            # (like the host-parity build) fails with "Expected attribute 'model' not found"
            self._isolated_dir = tempfile.TemporaryDirectory(prefix="parity_pte_")
            isolated_pte = Path(self._isolated_dir.name) / pte.name
            shutil.copy2(pte, isolated_pte)

            self.runner = ExecuTorchModelForCausalLM.from_pretrained(
                self._isolated_dir.name, file_name=pte.name, subfolder=""
            )
            self.method = "optimum.executorch ExecuTorchModelForCausalLM"
            return
        except Exception as exc:  # noqa: BLE001 - report whatever it raises
            print(f"optimum.executorch runtime unavailable: {type(exc).__name__}: {exc}")

        raise SystemExit(
            "No ExecuTorch host runtime could load the .pte.\n"
            "This is an export/runtime problem, not a model problem. Defer the parity\n"
            "check to the Mac per HANDOFF.md and record exactly what was tried."
        )

    def generate(self, built: prompt_mod.Prompt) -> str:
        text = self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": built.system},
                {"role": "user", "content": built.user},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
        # text_generation takes a tokenizer where .generate takes token ids. its max_seq_len
        # counts the prompt too, so the prompt length is added to match max_new_tokens
        prompt_len = len(self.tokenizer.encode(text))
        return self.runner.text_generation(  # type: ignore[union-attr]
            self.tokenizer,
            text,
            echo=False,
            max_seq_len=prompt_len + MAX_NEW_TOKENS,
        )

    def teacher_forced_argmax(self, full_ids: list[int], prompt_len: int) -> list[int]:
        """Feed `full_ids` one token at a time and collect the argmax at each completion position. Restarting cache_position at 0 is assumed to reset the KV cache; not verified against the C++ runtime."""
        import torch

        if len(full_ids) <= prompt_len:
            return []
        device = torch.device("cpu")
        argmaxes: list[int] = []
        for i, token in enumerate(full_ids[:-1]):
            logits = self.runner.forward(  # type: ignore[union-attr]
                input_ids=torch.tensor([token], dtype=torch.long, device=device).unsqueeze(0),
                cache_position=torch.tensor([i], dtype=torch.long, device=device),
            )
            if i >= prompt_len - 1:
                argmaxes.append(int(torch.argmax(logits, dim=-1).item()))
        return argmaxes


def build_full_token_ids(tokenizer, built: prompt_mod.Prompt, completion: str) -> tuple[list[int], int]:
    """The chat-templated prompt followed by the reference completion's tokens, in one sequence."""
    text = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": built.system},
            {"role": "user", "content": built.user},
        ],
        tokenize=False,
        add_generation_prompt=True,
    )
    prompt_ids = tokenizer(text)["input_ids"]
    completion_ids = tokenizer(completion, add_special_tokens=False)["input_ids"]
    return list(prompt_ids) + list(completion_ids), len(prompt_ids)


def hf_teacher_forced_argmax(hf, full_ids: list[int], prompt_len: int) -> list[int]:
    """One teacher-forced forward pass, collecting the argmax at each completion position."""
    if len(full_ids) <= prompt_len:
        return []
    input_ids = hf.torch.tensor([full_ids], dtype=hf.torch.long)
    with hf.torch.no_grad():
        logits = hf.model(input_ids=input_ids).logits
    return [int(logits[0, prompt_len + j - 1].argmax().item()) for j in range(len(full_ids) - prompt_len)]


def teacher_forced_agreement(pairs: list[tuple[list[int], list[int]]]) -> dict:
    """Pooled top-1 agreement and first divergence. A fully agreeing prompt counts its length as the divergence index; an empty one is skipped."""
    agreements = 0
    total = 0
    first_divergences: list[int] = []

    for reference_seq, executorch_seq in pairs:
        n = min(len(reference_seq), len(executorch_seq))
        if n == 0:
            continue
        first_divergence = n
        for i in range(n):
            if reference_seq[i] == executorch_seq[i]:
                agreements += 1
            elif first_divergence == n:
                first_divergence = i
        total += n
        first_divergences.append(first_divergence)

    fraction = (agreements / total) if total else None
    if first_divergences:
        ordered = sorted(first_divergences)
        mid = len(ordered) // 2
        median = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2
        minimum = ordered[0]
    else:
        median = None
        minimum = None

    return {
        "teacher_forced_top1_agreement": fraction,
        "completion_positions_compared": total,
        "prompts_compared": len(first_divergences),
        "first_divergence_index": {"median": median, "min": minimum},
    }


def score(records: list[dict], outputs: list[str]) -> dict:
    """The metrics parity compares, scored through eval.py so the two cannot disagree on what a metric means."""
    import eval as eval_mod

    metrics = eval_mod.score(records, outputs, [None] * len(records))
    return {key: metrics[key] for key in COMPARED_METRICS}


def exact_match_fraction(reference_out: list[str], executorch_out: list[str]) -> float:
    return sum(1 for a, b in zip(reference_out, executorch_out) if a.strip() == b.strip()) / len(reference_out)


def evaluate_gate(reference_metrics: dict, executorch_metrics: dict, exact: float) -> dict:
    """Schema-validity and per-metric rows against one reference. Exact match is reported but never counted as a failure."""
    rows: list[dict] = []
    failures = 0

    validity_gap = abs(reference_metrics["1_schema_first_try"] - executorch_metrics["1_schema_first_try"])
    ok = validity_gap <= VALIDITY_TOLERANCE
    failures += 0 if ok else 1
    rows.append(
        {
            "name": "schema validity",
            "reference": reference_metrics["1_schema_first_try"],
            "executorch": executorch_metrics["1_schema_first_try"],
            "gap": validity_gap,
            "tolerance": VALIDITY_TOLERANCE,
            "passed": ok,
            "note": "",
        }
    )

    ok = exact >= MIN_EXACT_MATCH
    # reported, not gated, so it stays visible beside the agreement floor
    rows.append(
        {
            "name": "exact string match",
            "reference": None,
            "executorch": exact,
            "gap": None,
            "tolerance": MIN_EXACT_MATCH,
            "passed": ok,
            "note": "(reported, not gated; DECISIONS.md 2026-09-07)",
        }
    )

    for key in COMPARED_METRICS:
        gap = abs(reference_metrics[key] - executorch_metrics[key])
        ok = gap <= METRIC_TOLERANCE
        failures += 0 if ok else 1
        rows.append(
            {
                "name": key,
                "reference": reference_metrics[key],
                "executorch": executorch_metrics[key],
                "gap": gap,
                "tolerance": METRIC_TOLERANCE,
                "passed": ok,
                "note": "",
            }
        )

    return {"rows": rows, "failures": failures}


def build_report(
    *,
    prompts_count: int,
    runtime: str,
    artifact: dict,
    metadata: dict | None,
    reference: str,
    gate_fp32: dict,
    exact_fp32: float,
    hf_metrics: dict,
    et_metrics: dict,
    gate_matched: dict | None,
    matched_metrics: dict | None,
    exact_matched: float | None,
    matched_identical_to_fp32: bool | None,
    tf_agreement_fp32: dict,
    tf_agreement_matched: dict | None,
) -> dict:
    """Assemble the parity.json payload. Gated on the matched reference when it ran, since a gap it reproduces is the recipe's cost, else on fp32."""
    gate_reference = "matched" if gate_matched is not None else "fp32"
    structural = gate_matched if gate_matched is not None else gate_fp32
    agreement_block = tf_agreement_matched if gate_matched is not None else tf_agreement_fp32
    agreement = agreement_block["teacher_forced_top1_agreement"] if agreement_block else None
    agreement_passed = agreement is not None and agreement >= MIN_TEACHER_FORCED_AGREEMENT
    return {
        "prompts": prompts_count,
        "runtime": runtime,
        "artifact": artifact,
        "export_recipe": metadata,
        "reference": reference,
        "gated_on": gate_reference,
        "passed": structural["failures"] == 0 and agreement_passed,
        "gate": {
            "reference": gate_reference,
            "structural_failures": structural["failures"],
            "teacher_forced_top1_agreement": agreement,
            "min_teacher_forced_top1_agreement": MIN_TEACHER_FORCED_AGREEMENT,
            "agreement_passed": agreement_passed,
            "exact_match_gated": False,
        },
        # older keys other tooling may read. always the fp32 numbers
        "exact_match": exact_fp32,
        "huggingface": hf_metrics,
        "executorch": et_metrics,
        # _vs_matched is None unless --reference matched ran
        "exact_match_vs_fp32": exact_fp32,
        "exact_match_vs_matched": exact_matched,
        "metrics_vs_fp32": {"huggingface": hf_metrics, "executorch": et_metrics},
        "metrics_vs_matched": (
            {"huggingface": matched_metrics, "executorch": et_metrics} if matched_metrics is not None else None
        ),
        "gate_rows_vs_fp32": gate_fp32["rows"],
        "gate_rows_vs_matched": gate_matched["rows"] if gate_matched is not None else None,
        "matched_recipe_identical_to_fp32": matched_identical_to_fp32 if reference == "matched" else None,
        "teacher_forced_top1_agreement_vs_fp32": tf_agreement_fp32,
        "teacher_forced_top1_agreement_vs_matched": tf_agreement_matched,
    }


def run_generation(runner, prompts: list[prompt_mod.Prompt], label: str) -> list[str]:
    print(f"\n--- {label} ---")
    started = time.time()
    outputs: list[str] = []
    for index, built in enumerate(prompts, start=1):
        outputs.append(runner.generate(built))
        if index % 5 == 0:
            print(f"  {index}/{len(prompts)}  {(time.time() - started) / index:.1f}s each", flush=True)
    return outputs


def print_table(gate_fp32: dict, gate_matched: dict | None) -> None:
    matched_active = gate_matched is not None
    header = f"{'comparison':28s} {'fp32':>8s} {'.pte':>8s} {'gap':>8s}"
    if matched_active:
        header += f" {'matched':>8s} {'gap(m)':>8s}"
    header += "  result"
    print(f"\n{header}")

    matched_by_name = {row["name"]: row for row in gate_matched["rows"]} if matched_active else {}

    for row in gate_fp32["rows"]:
        ref_str = f"{row['reference']:8.3f}" if row["reference"] is not None else f"{'':8s}"
        gap_str = f"{row['gap']:8.3f}" if row["gap"] is not None else f"{'':8s}"
        line = f"{row['name']:28s} {ref_str} {row['executorch']:8.3f} {gap_str}"
        if matched_active:
            mrow = matched_by_name.get(row["name"])
            if mrow is not None and mrow["reference"] is not None:
                line += f" {mrow['reference']:8.3f} {mrow['gap']:8.3f}"
            else:
                line += f" {'':8s} {'':8s}"
        line += f"  {'PASS' if row['passed'] else 'FAIL'}"
        if row["note"]:
            line += f" {row['note']}"
        print(line)


def print_agreement(label: str, agreement: dict) -> None:
    fraction = agreement["teacher_forced_top1_agreement"]
    if fraction is None:
        print(f"teacher-forced top-1 agreement vs {label}: no fixed prompt carries a completion; skipped")
        return
    fd = agreement["first_divergence_index"]
    print(
        f"teacher-forced top-1 agreement vs {label}: {fraction:.3f} "
        f"({agreement['completion_positions_compared']} completion positions, "
        f"{agreement['prompts_compared']} prompts); "
        f"first divergence index median={fd['median']}, min={fd['min']}"
    )


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--pte", type=Path, required=True)
    parser.add_argument(
        "--reference",
        choices=("fp32", "matched"),
        default="fp32",
        help=(
            "fp32 (default): compare against the merged checkpoint at full precision. "
            "matched: additionally compare against the checkpoint reproduced at the "
            "same recipe (export-metadata.json beside --pte) the exporter used for "
            "this .pte. The fp32 comparison always runs and is always reported; when "
            "matched runs, 'passed' is computed from the matched rows and the matched "
            "teacher-forced agreement (the shipping path for a quantized export), "
            "otherwise from the fp32 rows and agreement."
        ),
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_REPORT_PATH, help="where to write the parity report")
    args = parser.parse_args()

    for path in (args.model, args.pte):
        if not path.exists():
            raise SystemExit(f"missing {path}")

    metadata = load_export_metadata(args.pte)
    if args.reference == "matched" and metadata is None:
        raise SystemExit(
            f"--reference matched needs {metadata_path_for(args.pte)}, written by "
            "train/export.py beside the artifact it exported. Re-export (or export "
            "with a version of export.py that writes it), or run with --reference fp32."
        )

    records = fixed_prompts()
    prompts = [build(r) for r in records]
    print(f"{len(records)} fixed prompts from the sealed test split")

    hf = HuggingFaceRunner(args.model)
    hf_out = run_generation(hf, prompts, "Hugging Face (fp32)")

    et = ExecuTorchRunner(args.pte, args.model)
    print(f"runtime: {et.method}")
    et_out = run_generation(et, prompts, "ExecuTorch")

    hf_metrics = score(records, hf_out)
    et_metrics = score(records, et_out)
    exact_fp32 = exact_match_fraction(hf_out, et_out)

    gate_fp32 = evaluate_gate(hf_metrics, et_metrics, exact_fp32)

    matched_metrics: dict | None = None
    matched_out: list[str] | None = None
    exact_matched: float | None = None
    gate_matched: dict | None = None
    matched_identical_to_fp32 = False

    if args.reference == "matched":
        assert metadata is not None  # guarded above
        matched_identical_to_fp32 = matched_recipe_is_identical_to_fp32(metadata)
        if matched_identical_to_fp32:
            print("\nexport recipe has no quantization and no reduced-precision dtype: matched == fp32.")
            matched_out = hf_out
            matched_metrics = hf_metrics
        else:
            matched_hf = MatchedHuggingFaceRunner(args.model, metadata)
            matched_out = run_generation(matched_hf, prompts, "Hugging Face (matched)")
            matched_metrics = score(records, matched_out)
        exact_matched = exact_match_fraction(matched_out, et_out)
        gate_matched = evaluate_gate(matched_metrics, et_metrics, exact_matched)

    print_table(gate_fp32, gate_matched)

    # only over prompts with a sealed reference completion. all have one today
    tf_pairs_fp32: list[tuple[list[int], list[int]]] = []
    tf_pairs_matched: list[tuple[list[int], list[int]]] = []
    matched_runner_for_tf = None
    if args.reference == "matched":
        matched_runner_for_tf = hf if matched_identical_to_fp32 else matched_hf  # type: ignore[possibly-undefined]

    for record, built in zip(records, prompts):
        completion = record.get("completion")
        if not completion:
            continue
        full_ids, prompt_len = build_full_token_ids(hf.tokenizer, built, completion)
        hf_seq = hf_teacher_forced_argmax(hf, full_ids, prompt_len)
        et_seq = et.teacher_forced_argmax(full_ids, prompt_len)
        tf_pairs_fp32.append((hf_seq, et_seq))
        if matched_runner_for_tf is not None:
            matched_seq = hf_teacher_forced_argmax(matched_runner_for_tf, full_ids, prompt_len)
            tf_pairs_matched.append((matched_seq, et_seq))

    tf_agreement_fp32 = teacher_forced_agreement(tf_pairs_fp32)
    print_agreement("fp32", tf_agreement_fp32)
    tf_agreement_matched: dict | None = None
    if args.reference == "matched":
        tf_agreement_matched = teacher_forced_agreement(tf_pairs_matched)
        print_agreement("matched", tf_agreement_matched)

    # "hostparity" in the name is export.py's convention for its diagnostic build
    pte_bytes = args.pte.read_bytes()
    artifact = {
        "file_name": args.pte.name,
        "sha256": hashlib.sha256(pte_bytes).hexdigest(),
        "bytes": len(pte_bytes),
        "host_parity": "hostparity" in args.pte.stem.lower(),
    }
    del pte_bytes

    divergent = [
        (index, records[index], hf_out[index], et_out[index])
        for index in range(len(records))
        if hf_out[index].strip() != et_out[index].strip()
    ]
    if divergent:
        print(f"\n{len(divergent)}/{len(records)} prompts diverge between HF (fp32) and .pte output. First 3:")
        for index, record, hf_text, et_text in divergent[:3]:
            print(f"\n  [{index}] kind={record.get('kind')!r} task={record.get('task', {}).get('title', '')!r}")
            print(f"    HF:  {hf_text[:300]!r}")
            print(f"    .pte:{et_text[:300]!r}")

    report = build_report(
        prompts_count=len(records),
        runtime=et.method,
        artifact=artifact,
        metadata=metadata,
        reference=args.reference,
        gate_fp32=gate_fp32,
        exact_fp32=exact_fp32,
        hf_metrics=hf_metrics,
        et_metrics=et_metrics,
        gate_matched=gate_matched,
        matched_metrics=matched_metrics,
        exact_matched=exact_matched,
        matched_identical_to_fp32=matched_identical_to_fp32,
        tf_agreement_fp32=tf_agreement_fp32,
        tf_agreement_matched=tf_agreement_matched,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if not report["passed"]:
        gate = report["gate"]
        agreement_text = (
            f"{gate['teacher_forced_top1_agreement']:.3f}" if gate["teacher_forced_top1_agreement"] is not None else "n/a"
        )
        print(
            f"\nparity failed (gated on {gate['reference']}): {gate['structural_failures']} structural "
            f"comparison(s) out of tolerance; teacher-forced top-1 agreement {agreement_text} "
            f"against a floor of {gate['min_teacher_forced_top1_agreement']:.2f}."
        )
        print("Section 6: a parity failure is an EXPORT bug. Do not tune the model to")
        print("compensate. Re-export, or defer the export to the Mac per HANDOFF.md.")
        return 1

    print("\nParity holds. The artifact may be installed with train/export.py --install.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
