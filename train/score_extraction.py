"""Score whether extraction found the right tasks, dates and subjects in an eval.py --dump. Diagnostic only."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
REPORT_DIR = TRAIN_DIR / "reports"

# word jaccard two titles need to count as the same task
MATCH_THRESHOLD = 0.5


@dataclass(frozen=True)
class Task:
    title: str
    due_in_days: int
    subject: str | None


@dataclass(frozen=True)
class Match:
    ref: Task
    pred: Task


def _parse_tasks(validated: dict) -> list[Task]:
    return [
        Task(title=t["title"], due_in_days=t["dueInDays"], subject=t.get("subject"))
        for t in validated["tasks"]
    ]


def predicted_tasks(record: dict) -> tuple[list[Task], bool]:
    """Tasks from the completion, else the repair, else none and unparsed, like eval.py's repair fallback."""
    completion = record.get("completion") or ""
    result = validate_mod.validate_extraction(completion)
    if result.ok:
        return _parse_tasks(result.value), False

    repair = record.get("repair_completion")
    if repair is not None:
        repair_result = validate_mod.validate_extraction(repair)
        if repair_result.ok:
            return _parse_tasks(repair_result.value), False

    return [], True


def reference_tasks(record: dict) -> list[Task]:
    """The sealed completion is always valid, so it skips the validator."""
    return _parse_tasks(json.loads(record["reference"]))


def title_similarity(a: str, b: str) -> float:
    return validate_mod.jaccard(set(validate_mod.words(a)), set(validate_mod.words(b)))


def match_tasks(refs: list[Task], preds: list[Task]) -> list[Match]:
    """Greedy title matching, best first, each task used once. Ties break on index so the result is stable."""
    candidates: list[tuple[float, int, int]] = []
    for ri, ref in enumerate(refs):
        for pi, pred in enumerate(preds):
            similarity = title_similarity(ref.title, pred.title)
            if similarity >= MATCH_THRESHOLD:
                candidates.append((similarity, ri, pi))
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))

    matched_refs: set[int] = set()
    matched_preds: set[int] = set()
    matches: list[Match] = []
    for _similarity, ri, pi in candidates:
        if ri in matched_refs or pi in matched_preds:
            continue
        matched_refs.add(ri)
        matched_preds.add(pi)
        matches.append(Match(ref=refs[ri], pred=preds[pi]))
    return matches


def _ratio(numerator: int, denominator: int) -> float | None:
    """None, not 0.0, for an empty denominator, so missing data never reads as a score."""
    return (numerator / denominator) if denominator else None


def _due_bucket(diff: int) -> str:
    if diff == 0:
        return "0"
    if diff == 1:
        return "1"
    if diff <= 3:
        return "2-3"
    if diff <= 7:
        return "4-7"
    return "more"


def score(dump_records: list[dict]) -> dict:
    """Metrics pooled over every extraction record, so a five-task record outweighs a one-task one."""
    records = [r for r in dump_records if r["kind"] == "extraction"]

    total_ref_tasks = 0
    total_pred_tasks = 0
    total_matched = 0
    due_exact = 0
    due_within_1 = 0
    due_abs_errors: list[int] = []
    subject_agree = 0
    unparsed = 0
    empty_reference_records = 0
    empty_correct = 0
    due_error_histogram = {"0": 0, "1": 0, "2-3": 0, "4-7": 0, "more": 0}

    for record in records:
        refs = reference_tasks(record)
        preds, is_unparsed = predicted_tasks(record)
        if is_unparsed:
            unparsed += 1

        total_ref_tasks += len(refs)
        total_pred_tasks += len(preds)

        if not refs:
            empty_reference_records += 1
            if not preds:
                empty_correct += 1

        for match in match_tasks(refs, preds):
            total_matched += 1

            diff = abs(match.ref.due_in_days - match.pred.due_in_days)
            due_abs_errors.append(diff)
            due_error_histogram[_due_bucket(diff)] += 1
            if diff == 0:
                due_exact += 1
            if diff <= 1:
                due_within_1 += 1

            ref_subject = match.ref.subject
            pred_subject = match.pred.subject
            if ref_subject is None and pred_subject is None:
                subject_agree += 1
            elif (
                ref_subject is not None
                and pred_subject is not None
                and ref_subject.lower() == pred_subject.lower()
            ):
                subject_agree += 1

    return {
        "records": len(records),
        "unparsed": unparsed,
        "reference_tasks": total_ref_tasks,
        "predicted_tasks": total_pred_tasks,
        "matched_pairs": total_matched,
        "task_recall": _ratio(total_matched, total_ref_tasks),
        "task_precision": _ratio(total_matched, total_pred_tasks),
        "due_exact": _ratio(due_exact, total_matched),
        "due_within_1": _ratio(due_within_1, total_matched),
        "due_mean_abs_error": (
            sum(due_abs_errors) / len(due_abs_errors) if due_abs_errors else None
        ),
        "subject_match": _ratio(subject_agree, total_matched),
        "empty_reference_records": empty_reference_records,
        "empty_correct": _ratio(empty_correct, empty_reference_records),
        "due_error_histogram": due_error_histogram,
    }


def load_dump(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def _fmt(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def print_table(label: str, metrics: dict) -> None:
    print(f"\n=== {label} (extraction diagnostic) ===")
    print(
        f"records {metrics['records']}   unparsed {metrics['unparsed']}   "
        f"empty-reference records {metrics['empty_reference_records']}"
    )
    print(
        f"reference tasks {metrics['reference_tasks']}   "
        f"predicted tasks {metrics['predicted_tasks']}   "
        f"matched pairs {metrics['matched_pairs']}"
    )
    print(f"\n{'metric':22s} {'value':>8s}")
    for key in (
        "task_recall",
        "task_precision",
        "due_exact",
        "due_within_1",
        "due_mean_abs_error",
        "subject_match",
        "empty_correct",
    ):
        print(f"{key:22s} {_fmt(metrics[key]):>8s}")
    print("\ndue-day error histogram (matched pairs):")
    for bucket in ("0", "1", "2-3", "4-7", "more"):
        print(f"  {bucket:>4s}  {metrics['due_error_histogram'][bucket]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", type=Path, required=True, help="eval.py --dump jsonl to score")
    parser.add_argument("--out", type=Path, default=None, help="where to write the report json")
    parser.add_argument(
        "--label", default=None, help="report label; defaults to the dump file's stem"
    )
    args = parser.parse_args()

    dump_records = load_dump(args.dump)
    label = args.label or args.dump.stem
    metrics = score(dump_records)
    print_table(label, metrics)

    out = args.out or REPORT_DIR / f"{label}.extraction-score.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "dump": str(args.dump),
        "label": label,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **metrics,
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"\nreport  {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
