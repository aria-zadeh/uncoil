"""Reject a batch that passes the validator but keeps reusing the same steps."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent / "data_sources"

# calibrated on hand-authored sources: test and anchor sit at 0.90 or above, adversarial
# at 0.73 (generic on purpose), and the bad synthesized batch at 0.18. max_share is not
# gated because that batch spread its repeats evenly and scored lower than good ones
MIN_STEP_UNIQUENESS = 0.75
MIN_FIRST_STEP_UNIQUENESS = 0.75


def measure(records: list[dict]) -> dict:
    steps: Counter[str] = Counter()
    firsts: Counter[str] = Counter()
    breakdowns = 0
    for record in records:
        if record["kind"] != "breakdown":
            continue
        breakdowns += 1
        parsed = json.loads(record["completion"])
        for step in parsed["steps"]:
            steps[step["title"]] += 1
        firsts[parsed["steps"][0]["title"]] += 1

    total = sum(steps.values())
    most_common = steps.most_common(1)[0] if steps else ("", 0)
    return {
        "samples": len(records),
        "breakdowns": breakdowns,
        "steps": total,
        "unique_steps": len(steps),
        "step_ratio": (len(steps) / total) if total else 1.0,
        "first_ratio": (len(firsts) / breakdowns) if breakdowns else 1.0,
        "max_share": (most_common[1] / total) if total else 0.0,
        "worst": most_common,
        "step_counter": steps,
        "first_counter": firsts,
    }


def report(label: str, stats: dict, *, gated: bool) -> bool:
    ok = (
        stats["step_ratio"] >= MIN_STEP_UNIQUENESS
        and stats["first_ratio"] >= MIN_FIRST_STEP_UNIQUENESS
    )
    # ungated files are references. FAIL on adversarial/ would read as a corpus defect
    verdict = ("PASS" if ok else "FAIL") if gated else ("ref " if ok else "ref!")
    print(
        f"{verdict}  {label:34s} samples={stats['samples']:4d} breakdowns={stats['breakdowns']:4d} "
        f"steps={stats['steps']:5d}  unique={stats['step_ratio']:.2f}  "
        f"first={stats['first_ratio']:.2f}  max_share={stats['max_share']:.3f}"
    )
    if not ok and gated:
        print(
            f"      needs unique >= {MIN_STEP_UNIQUENESS} and first >= {MIN_FIRST_STEP_UNIQUENESS}. "
            f"{stats['unique_steps']} distinct step sentences carry {stats['steps']} steps."
        )
        print("      most reused step titles:")
        for title, count in stats["step_counter"].most_common(6):
            print(f"        {count:4d}x  {title}")
        print("      most reused FIRST steps:")
        for title, count in stats["first_counter"].most_common(6):
            print(f"        {count:4d}x  {title}")
    return ok if gated else True


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    paths = list(args.paths)
    if args.all:
        # review-<batch>.json files beside a batch are blind-review verdicts, not data
        paths = sorted(q for q in SOURCE_DIR.rglob("*.json") if not q.name.startswith("review-"))
    if not paths:
        parser.error("give a path or --all")

    failures = 0
    combined: list[dict] = []
    for path in paths:
        records = json.loads(path.read_text(encoding="utf-8"))
        combined.extend(records)
        gated = path.parent.name == "synthesized"
        label = f"{path.parent.name}/{path.name}"
        if not report(label, measure(records), gated=gated):
            failures += 1

    if len(paths) > 1:
        print()
        report("ALL FILES COMBINED", measure(combined), gated=False)
        print(
            "\nThe combined line is the one that matters for the corpus: two batches "
            "that each pass alone but reuse each other's sentences are still a "
            "narrow training set."
        )

    if failures:
        print(f"\n{failures} file(s) below the diversity floor.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
