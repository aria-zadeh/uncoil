"""Blind pairwise preference between two model samples on the same prompts. Rules in train/METRIC6_PROTOCOL.md."""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate as validate_mod


def load_sample(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def steps_of(completion: str) -> list[dict] | None:
    sliced = validate_mod.strip_to_json(completion)
    if sliced is None:
        return None
    try:
        parsed = json.loads(sliced)
    except json.JSONDecodeError:
        return None
    steps = parsed.get("steps")
    if not isinstance(steps, list):
        return None
    return [
        {"title": s.get("title"), "minutes": s.get("minutes")}
        for s in steps
        if isinstance(s, dict)
    ]


def build(args: argparse.Namespace) -> int:
    left = load_sample(args.left)
    right = load_sample(args.right)
    rows_dir = args.out_dir / "rows"
    rows_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "verdicts").mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    key: dict[str, dict] = {}
    written = 0
    for index, (l_rec, r_rec) in enumerate(zip(left, right)):
        if l_rec["task"] != r_rec["task"]:
            raise SystemExit(f"row {index}: the two samples carry different tasks; they must share prompts")
        l_steps, r_steps = steps_of(l_rec["completion"]), steps_of(r_rec["completion"])
        if l_steps is None or r_steps is None:
            # an unparsed side is already counted as a parse failure, and preferring garbage says nothing
            continue
        left_is_a = rng.random() < 0.5
        a, b = (l_steps, r_steps) if left_is_a else (r_steps, l_steps)
        task = l_rec["task"]
        row = {
            "assignment": {
                "title": task.get("title"),
                "subject": task.get("subject"),
                "description": task.get("description"),
                "sessionMinutes": task.get("sessionMinutes"),
            },
            "A": {"steps": a},
            "B": {"steps": b},
        }
        name = f"row-{index:03d}"
        (rows_dir / f"{name}.json").write_text(json.dumps(row, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        key[name] = {"A": "left" if left_is_a else "right", "B": "right" if left_is_a else "left"}
        written += 1
    (args.out_dir / "key.json").write_text(
        json.dumps({"left": str(args.left), "right": str(args.right), "seed": args.seed, "rows": key}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {written} row files to {rows_dir}; private key at {args.out_dir / 'key.json'}")
    return 0


def score(args: argparse.Namespace) -> int:
    key = json.loads((args.out_dir / "key.json").read_text(encoding="utf-8"))
    verdicts_dir = args.out_dir / "verdicts"
    counts: Counter = Counter()
    side_counts: Counter = Counter()
    missing = []
    for name, sides in key["rows"].items():
        path = verdicts_dir / f"{name}.verdict.json"
        if not path.exists():
            missing.append(name)
            continue
        verdict = json.loads(path.read_text(encoding="utf-8"))
        if not verdict.get("judge") or not verdict.get("session"):
            raise SystemExit(f"{path}: judge and session are mandatory")
        pick = verdict.get("preferred")
        if pick not in ("A", "B", "tie"):
            raise SystemExit(f"{path}: preferred must be A, B or tie")
        side_counts[pick] += 1
        counts["tie" if pick == "tie" else sides[pick]] += 1
    if missing:
        raise SystemExit(f"{len(missing)} rows without a verdict: {missing[:5]}")
    total = sum(counts.values())
    result = {
        "left": key["left"],
        "right": key["right"],
        "rows": total,
        "left_preferred": counts["left"] / total,
        "right_preferred": counts["right"] / total,
        "tie": counts["tie"] / total,
        "raw_side_picks": {"A": side_counts["A"], "B": side_counts["B"], "tie": side_counts["tie"]},
    }
    (args.out_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--left", type=Path, required=True)
    b.add_argument("--right", type=Path, required=True)
    b.add_argument("--out-dir", type=Path, required=True)
    b.add_argument("--seed", type=int, default=42)
    b.set_defaults(func=build)
    s = sub.add_parser("score")
    s.add_argument("--out-dir", type=Path, required=True)
    s.set_defaults(func=score)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
