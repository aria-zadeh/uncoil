"""Re-label an eval dump's extraction dates with due_dates.py, so scoring it measures task-finding alone."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import due_dates as due_dates_mod
import score_extraction as score_mod


def _task_to_dict(task: score_mod.Task) -> dict:
    entry = {"title": task.title, "dueInDays": task.due_in_days}
    if task.subject is not None:
        entry["subject"] = task.subject
    return entry


def reconcile_record(record: dict) -> tuple[dict, int, int, int]:
    """A record that does not validate passes through as an empty task list, as score_extraction counts it."""
    predicted, _is_unparsed = score_mod.predicted_tasks(record)
    task_dicts = [_task_to_dict(t) for t in predicted]

    reconciled = due_dates_mod.reconcile_due_dates(
        task_dicts,
        record["task"].get("text", ""),
        record["task"].get("today", "Monday"),
        today_date=None,
    )

    from_text = sum(1 for t in reconciled if t.get("dueSource") == "text")
    changed = sum(
        1
        for original, new in zip(task_dicts, reconciled)
        if original["dueInDays"] != new["dueInDays"]
    )

    clean_tasks = [{k: v for k, v in t.items() if k != "dueSource"} for t in reconciled]
    new_completion = json.dumps({"tasks": clean_tasks}, ensure_ascii=False)

    new_record = {
        **record,
        "completion": new_completion,
        "repair_completion": None,
        "repair_verdict": None,
    }
    return new_record, len(task_dicts), from_text, changed


def reconcile_dump(records: list[dict]) -> tuple[list[dict], dict]:
    new_records: list[dict] = []
    extraction_records = 0
    total_tasks = 0
    total_from_text = 0
    total_changed = 0

    for record in records:
        if record.get("kind") != "extraction":
            new_records.append(record)
            continue
        extraction_records += 1
        new_record, task_count, from_text, changed = reconcile_record(record)
        new_records.append(new_record)
        total_tasks += task_count
        total_from_text += from_text
        total_changed += changed

    summary = {
        "extraction_records": extraction_records,
        "tasks": total_tasks,
        "set_from_text": total_from_text,
        "changed": total_changed,
    }
    return new_records, summary


def load_dump(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", type=Path, required=True, help="eval.py --dump jsonl to reconcile")
    parser.add_argument("--out", type=Path, required=True, help="where to write the reconciled dump")
    args = parser.parse_args()

    records = load_dump(args.dump)
    if not records:
        raise SystemExit(f"{args.dump}: empty dump")

    new_records, summary = reconcile_dump(records)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        for record in new_records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(
        f"reconciled {summary['extraction_records']} extraction records, "
        f"{summary['tasks']} tasks"
    )
    print(f"  set from text   {summary['set_from_text']}")
    print(f"  dueInDays changed {summary['changed']}")
    print(f"\ndump  {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
