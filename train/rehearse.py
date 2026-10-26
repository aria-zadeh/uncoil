"""Run each demo prompt N times through the shipped artifact and tally the tier the app would serve. Not a gate."""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval as eval_mod
import prompt as prompt_mod
import score_extraction
import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
DEFAULT_PROMPTS = TRAIN_DIR / "rehearsal" / "demo-prompts.json"
REPORT_DIR = TRAIN_DIR / "reports"

# run 0 keeps eval.py's seed. a large odd stride keeps runs clear of neighbouring prompts' seeds
RUN_SEED_STRIDE = 1_000_003

TIERS = ("model", "repaired", "template")


def load_prompts(path: Path) -> list[dict]:
    prompts = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(prompts, list) or not prompts:
        raise SystemExit(f"{path}: expected a non-empty list")
    seen: set[str] = set()
    for entry in prompts:
        for key in ("id", "kind", "task"):
            if key not in entry:
                raise SystemExit(f"{path}: every prompt needs {key!r}; got {sorted(entry)}")
        if entry["kind"] not in ("breakdown", "extraction", "simplification"):
            raise SystemExit(f"{path}: unknown kind {entry['kind']!r} on {entry['id']!r}")
        if entry["id"] in seen:
            raise SystemExit(f"{path}: duplicate id {entry['id']!r}")
        seen.add(entry["id"])
    return prompts


def classify(kind: str, task: dict, raw: str, repair_raw: str | None) -> dict:
    """The tier services/generationPipeline.ts would serve for these attempts, plus both verdicts."""
    first = validate_mod.verdict(kind, raw, task)
    if first["ok"]:
        return {"tier": "model", "verdict": first, "repair_verdict": None}
    second = validate_mod.verdict(kind, repair_raw, task) if repair_raw is not None else None
    tier = "repaired" if second is not None and second["ok"] else "template"
    return {"tier": tier, "verdict": first, "repair_verdict": second}


def summarize(rows: list[dict], prompts: list[dict]) -> dict:
    """Per-prompt and overall tier counts."""
    by_prompt: dict[str, Counter] = {p["id"]: Counter() for p in prompts}
    reasons: Counter = Counter()
    seconds: dict[str, list[float]] = {p["id"]: [] for p in prompts}
    for row in rows:
        by_prompt[row["id"]][row["tier"]] += 1
        seconds[row["id"]].append(row["seconds"])
        if row["tier"] != "model":
            reasons[row["verdict"]["code"] or "unknown"] += 1
    per_prompt = {}
    for entry in prompts:
        counts = by_prompt[entry["id"]]
        runs = sum(counts.values())
        per_prompt[entry["id"]] = {
            "kind": entry["kind"],
            "runs": runs,
            **{tier: counts[tier] for tier in TIERS},
            "template_rate": (counts["template"] / runs) if runs else None,
            "mean_seconds": (sum(seconds[entry["id"]]) / runs) if runs else None,
        }
    total = Counter()
    for counts in by_prompt.values():
        total.update(counts)
    runs = sum(total.values())
    worst = max(per_prompt.items(), key=lambda kv: (kv[1]["template_rate"] or 0.0)) if per_prompt else None
    return {
        "runs": runs,
        **{tier: total[tier] for tier in TIERS},
        "template_rate": (total["template"] / runs) if runs else None,
        "model_first_try_rate": (total["model"] / runs) if runs else None,
        "first_attempt_rejections": dict(reasons),
        "worst_prompt": worst[0] if worst else None,
        "per_prompt": per_prompt,
    }


def extraction_dump_records(rows: list[dict], prompts: list[dict]) -> list[dict]:
    """Shape rows that carry an `expected` list the way score_extraction.score reads a dump."""
    expected_by_id = {p["id"]: p.get("expected") for p in prompts if p["kind"] == "extraction"}
    records = []
    for row in rows:
        expected = expected_by_id.get(row["id"])
        if row["kind"] != "extraction" or not expected:
            continue
        records.append(
            {
                "kind": "extraction",
                "task": row["task"],
                "reference": json.dumps({"tasks": expected}),
                "completion": row["completion"],
                "verdict": row["verdict"],
                "repair_completion": row["repair_completion"],
                "repair_verdict": row["repair_verdict"],
            }
        )
    return records


def print_summary(label: str, summary: dict, extraction: dict | None) -> None:
    print(f"\n{label}: {summary['runs']} generations")
    print(f"{'prompt':28s} {'kind':11s} {'runs':>4s} {'model':>5s} {'repair':>6s} {'templ':>5s} {'s/run':>6s}")
    for name, row in summary["per_prompt"].items():
        mean = f"{row['mean_seconds']:6.1f}" if row["mean_seconds"] is not None else "   n/a"
        print(
            f"{name:28s} {row['kind']:11s} {row['runs']:4d} {row['model']:5d} {row['repaired']:6d} "
            f"{row['template']:5d} {mean}"
        )
    rate = summary["template_rate"]
    print(
        f"\ntemplate rate {rate:.3f}" if rate is not None else "\ntemplate rate n/a",
        f"({summary['template']} of {summary['runs']}); first-try model rate "
        f"{summary['model_first_try_rate']:.3f}" if summary["model_first_try_rate"] is not None else "",
    )
    if summary["first_attempt_rejections"]:
        print(f"first-attempt rejections: {summary['first_attempt_rejections']}")
    if summary["worst_prompt"]:
        print(f"worst prompt: {summary['worst_prompt']}")
    if extraction:
        print(
            f"extraction (pooled over runs with an expected list): recall {extraction['task_recall']}, "
            f"precision {extraction['task_precision']}, due exact {extraction['due_exact']}, "
            f"within one day {extraction['due_within_1']}"
        )


def rescore(args: argparse.Namespace, prompts: list[dict]) -> int:
    """Re-classify a recorded rehearsal under the current validator, without generating."""
    rows = [json.loads(line) for line in args.rescore_dump.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit(f"{args.rescore_dump}: empty dump")
    for row in rows:
        outcome = classify(row["kind"], row["task"], row["completion"], row.get("repair_completion"))
        row.update(outcome)
    label = args.label or f"{args.rescore_dump.stem.replace('.dump', '')}-rescored"
    slug = label.replace("/", "_").replace(":", "_")
    out = args.out or REPORT_DIR / f"{slug}.json"
    dump = args.dump or REPORT_DIR / f"{slug}.dump.jsonl"
    summary = summarize(rows, prompts)
    extraction_records = extraction_dump_records(rows, prompts)
    extraction = score_extraction.score(extraction_records) if extraction_records else None
    print_summary(label, summary, extraction)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "label": label,
        "prompts_path": str(args.prompts),
        "rescored_from": str(args.rescore_dump),
        "runs_per_prompt": max((r["run"] for r in rows), default=-1) + 1,
        "git_commit": eval_mod.git_commit_hash(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "extraction": extraction,
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    with dump.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"\nreport {out}\ndump   {dump}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=None, help="checkpoint directory (tokenizer and chat template; the model itself without --pte)")
    parser.add_argument("--pte", type=Path, default=None, help="exported ExecuTorch program to rehearse instead of the checkpoint")
    parser.add_argument(
        "--rescore-dump",
        type=Path,
        default=None,
        help="re-classify an earlier rehearsal dump under the current validator, no generation (see eval.py --rescore-dump)",
    )
    parser.add_argument("--prompts", type=Path, default=DEFAULT_PROMPTS)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--label", default=None)
    parser.add_argument("--device", choices=["cpu"], default="cpu", help="CPU only; MPS rows are void (LESSONS 2026-09-06)")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--dump", type=Path, default=None)
    args = parser.parse_args()

    if args.runs < 1:
        parser.error("--runs must be at least 1")
    prompts = load_prompts(args.prompts)
    if args.rescore_dump:
        return rescore(args, prompts)
    if not args.model:
        parser.error("--model is required unless --rescore-dump is given")
    label = args.label or (f"pte-rehearsal" if args.pte else "rehearsal")
    slug = label.replace("/", "_").replace(":", "_")
    out = args.out or REPORT_DIR / f"{slug}.json"
    dump = args.dump or REPORT_DIR / f"{slug}.dump.jsonl"

    generator = (
        eval_mod.PteGenerator(str(args.pte), args.model, args.device)
        if args.pte
        else eval_mod.Generator(args.model, args.device)
    )

    rows: list[dict] = []
    started = time.time()
    total = args.runs * len(prompts)
    for run in range(args.runs):
        generator.seed_offset = run * RUN_SEED_STRIDE
        for entry in prompts:
            record = {"kind": entry["kind"], "task": entry["task"]}
            built = eval_mod.build_prompt(record)
            t0 = time.time()
            raw = generator.generate(built)
            first_seconds = time.time() - t0
            first = validate_mod.verdict(entry["kind"], raw, entry["task"])
            repair_raw: str | None = None
            if not first["ok"]:
                repair_raw = generator.generate(prompt_mod.build_repair_prompt(built, first["reason"]))
            outcome = classify(entry["kind"], entry["task"], raw, repair_raw)
            rows.append(
                {
                    "id": entry["id"],
                    "kind": entry["kind"],
                    "run": run,
                    "seed_offset": generator.seed_offset,
                    "task": entry["task"],
                    "completion": raw,
                    "repair_completion": repair_raw,
                    "tier": outcome["tier"],
                    "verdict": outcome["verdict"],
                    "repair_verdict": outcome["repair_verdict"],
                    "seconds": time.time() - t0,
                    "first_attempt_seconds": first_seconds,
                }
            )
            done = len(rows)
            rate = (time.time() - started) / done
            print(
                f"  run {run} {entry['id']:28s} {outcome['tier']:9s} {rows[-1]['seconds']:5.1f}s  "
                f"{done}/{total}  eta {(total - done) * rate / 60:.1f} min",
                flush=True,
            )

    summary = summarize(rows, prompts)
    extraction_records = extraction_dump_records(rows, prompts)
    extraction = score_extraction.score(extraction_records) if extraction_records else None
    print_summary(label, summary, extraction)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "label": label,
        "prompts_path": str(args.prompts),
        "model_path": f"pte:{args.pte}" if args.pte else args.model,
        "runs_per_prompt": args.runs,
        "git_commit": eval_mod.git_commit_hash(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decoding": {
            "temperature": eval_mod.TEMPERATURE,
            "top_p": eval_mod.TOP_P,
            "max_new_tokens": eval_mod.MAX_NEW_TOKENS,
            "repair": True,
            "backend": "executorch" if args.pte else "huggingface",
            "run_seed_stride": RUN_SEED_STRIDE,
        },
        "summary": summary,
        "extraction": extraction,
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    dump.parent.mkdir(parents=True, exist_ok=True)
    with dump.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"\nreport {out}\ndump   {dump}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
