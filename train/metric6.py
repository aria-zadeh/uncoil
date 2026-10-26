"""Metric 6: blind per-row judging of whether a first step is startable within two minutes. See train/METRIC6_PROTOCOL.md."""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

TRAIN_DIR = Path(__file__).resolve().parent
REPORTS = TRAIN_DIR / "reports"

METRIC6_DIR = REPORTS / "metric6"
ROWS_DIR = METRIC6_DIR / "rows"
KEY_FILE = METRIC6_DIR / "key.json"
VERDICTS_DIR = METRIC6_DIR / "verdicts"
RESULT = REPORTS / "metric6.json"

MODEL_SAMPLE = REPORTS / "finetuned-breakdown.metric6-sample.jsonl"
TEMPLATE_SAMPLE = REPORTS / "templates-breakdown.metric6-sample.jsonl"

METRIC_6_GATE = 0.85
DEFAULT_SEED = 42  # same as the training seed
DEFAULT_CONTROLS = 10

REQUIRED_VERDICT_FIELDS = (
    "judge",
    "session",
    "startable_A",
    "startable_B",
    "fit",
    "reason_A",
    "reason_B",
    "reason_fit",
)

if str(TRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(TRAIN_DIR))
import validate as v  # noqa: E402


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def steps_from_completion(completion: str) -> list[dict] | None:
    """Steps from a raw completion, or None when it has no steps list. Those rows are never shown to a judge."""
    stripped = v.strip_to_json(completion)
    if stripped is None:
        return None
    try:
        parsed = json.loads(stripped)
        steps = parsed["steps"]
        return [{"title": s["title"], "minutes": s["minutes"]} for s in steps]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return None


def _group_by_title(rows: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["task"].get("title"), []).append(row)
    return grouped


def _assignment_of(row: dict) -> dict:
    task = row["task"]
    return {
        "title": task.get("title"),
        "description": task.get("description"),
        "sessionMinutes": task.get("sessionMinutes"),
    }


def cmd_build(args: argparse.Namespace) -> int:
    model_rows = read_jsonl(args.model_sample)
    template_rows = read_jsonl(args.template_sample)
    if len(model_rows) != len(template_rows):
        raise SystemExit(f"{len(model_rows)} model rows against {len(template_rows)} template rows")

    rng = random.Random(args.seed)

    # base rows: one model side, one templates side
    base_items = []
    for index, (m, t) in enumerate(zip(model_rows, template_rows)):
        if m["task"].get("title") != t["task"].get("title"):
            raise SystemExit(f"row {index} is not the same task in both files")
        m_steps = steps_from_completion(m["completion"])
        t_steps = steps_from_completion(t["completion"])
        if not m_steps or not t_steps:
            continue
        base_items.append(
            {
                "assignment": _assignment_of(m),
                "model_steps": m_steps,
                "template_steps": t_steps,
            }
        )

    if not base_items:
        raise SystemExit("no usable rows survived validation -- nothing to build")

    entries: list[tuple[dict, dict]] = []  # (row content, private key entry)

    for item in base_items:
        # drawn per row, not alternated, so position gives nothing away
        model_side = rng.choice(["A", "B"])
        other_side = "B" if model_side == "A" else "A"
        row = {"assignment": item["assignment"]}
        row[model_side] = {"steps": item["model_steps"]}
        row[other_side] = {"steps": item["template_steps"]}
        entries.append((row, {"control": False, "model_side": model_side}))

    # control rows: the same system on both sides
    n_controls = max(0, args.controls)
    n_model_ctrl = n_controls // 2
    n_template_ctrl = n_controls - n_model_ctrl
    control_kinds = ["model"] * n_model_ctrl + ["templates"] * n_template_ctrl
    rng.shuffle(control_kinds)

    model_by_title = _group_by_title(model_rows)
    template_by_title = _group_by_title(template_rows)

    for kind in control_kinds:
        source_rows = model_rows if kind == "model" else template_rows
        by_title = model_by_title if kind == "model" else template_by_title
        pick = rng.choice(source_rows)
        candidates = by_title.get(pick["task"].get("title"), [pick])

        if len(candidates) >= 2:
            # two different samples of the same system, when the input has more than one
            c1, c2 = rng.sample(candidates, 2)
            distinct = True
        else:
            c1 = c2 = candidates[0]
            distinct = False

        a_steps = steps_from_completion(c1["completion"])
        b_steps = steps_from_completion(c2["completion"])
        if not a_steps or not b_steps:
            continue

        row = {
            "assignment": _assignment_of(c1),
            "A": {"steps": a_steps},
            "B": {"steps": b_steps},
        }
        entries.append(
            (
                row,
                {
                    "control": True,
                    "control_kind": f"{kind}_vs_{kind}",
                    "system": kind,
                    "distinct_completions": distinct,
                },
            )
        )

    # clustered control rows would leak which rows they are
    rng.shuffle(entries)

    rows_dir: Path = args.rows_dir
    rows_dir.mkdir(parents=True, exist_ok=True)
    for stale in rows_dir.glob("row-*.json"):
        stale.unlink()

    width = max(3, len(str(len(entries) - 1)))
    key_rows: dict[str, dict] = {}
    n_control_written = 0
    for i, (row, key_entry) in enumerate(entries):
        row_id = f"row-{i:0{width}d}"
        (rows_dir / f"{row_id}.json").write_text(
            json.dumps(row, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        key_rows[row_id] = key_entry
        if key_entry["control"]:
            n_control_written += 1

    key = {
        "protocol": "per-row-blind-v2",
        "seed": args.seed,
        "controls": n_control_written,
        "n_rows": len(entries),
        "model_sample": str(args.model_sample),
        "template_sample": str(args.template_sample),
        "rows": key_rows,
    }
    args.key.parent.mkdir(parents=True, exist_ok=True)
    args.key.write_text(json.dumps(key, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        f"wrote {len(entries)} row files to {rows_dir} "
        f"({len(entries) - n_control_written} base, {n_control_written} control)"
    )
    print(f"wrote private key to {args.key} -- the judge must never see this file")
    print("see train/METRIC6_PROTOCOL.md for the judge instructions")
    return 0


def _judged_by_label(judges: set[str]) -> str:
    if len(judges) == 1:
        who = next(iter(judges))
    else:
        who = "multiple judges: " + ", ".join(sorted(judges))
    return f"{who}, blind A/B, per-row"


def cmd_score(args: argparse.Namespace) -> int:
    key_path: Path = args.key
    if not key_path.exists():
        raise SystemExit(f"key file not found: {key_path} -- run `build` first")
    key = json.loads(key_path.read_text(encoding="utf-8"))
    key_mtime = key_path.stat().st_mtime
    rows: dict[str, dict] = key["rows"]
    if not rows:
        raise SystemExit(f"{key_path} has no rows")

    verdicts: dict[str, dict] = {}
    missing: list[str] = []
    incomplete: list[tuple[str, str]] = []
    stale_key: list[str] = []

    for row_id in rows:
        vpath = args.verdicts_dir / f"{row_id}.verdict.json"
        if not vpath.exists():
            missing.append(row_id)
            continue
        verdict = json.loads(vpath.read_text(encoding="utf-8"))
        for field in REQUIRED_VERDICT_FIELDS:
            if field not in verdict or verdict[field] in (None, ""):
                incomplete.append((row_id, field))
        # a key newer than an existing verdict was edited after judging, e.g. sides
        # relabelled once the outcome was known
        if key_mtime > vpath.stat().st_mtime:
            stale_key.append(row_id)
        verdicts[row_id] = verdict

    if missing:
        raise SystemExit(
            f"missing verdict file(s) for: {', '.join(sorted(missing))} "
            f"(looked in {args.verdicts_dir})"
        )
    if incomplete:
        detail = ", ".join(f"{row_id}:{field}" for row_id, field in incomplete)
        raise SystemExit(f"verdict file(s) missing required field(s): {detail}")
    if stale_key:
        raise SystemExit(
            "key.json was modified after verdict file(s) already existed for: "
            + ", ".join(sorted(stale_key))
            + " -- the key must be written once, before judging, and never touched again"
        )

    model_startable = template_startable = 0
    model_fit = template_fit = ties = 0
    counted = 0

    control_fit_a = control_fit_b = control_fit_tie = 0
    control_disagree = 0
    control_n = 0

    judges: set[str] = set()
    sessions: set[str] = set()

    for row_id, entry in rows.items():
        verdict = verdicts[row_id]
        judges.add(str(verdict["judge"]))
        sessions.add(str(verdict["session"]))

        if entry["control"]:
            control_n += 1
            fit = verdict.get("fit")
            if fit == "A":
                control_fit_a += 1
            elif fit == "B":
                control_fit_b += 1
            else:
                control_fit_tie += 1
            if bool(verdict["startable_A"]) != bool(verdict["startable_B"]):
                control_disagree += 1
            continue

        counted += 1
        model_side = entry["model_side"]
        other = "B" if model_side == "A" else "A"

        if verdict[f"startable_{model_side}"]:
            model_startable += 1
        if verdict[f"startable_{other}"]:
            template_startable += 1

        fit = verdict.get("fit")
        if fit == model_side:
            model_fit += 1
        elif fit == other:
            template_fit += 1
        else:
            ties += 1

    if counted == 0:
        raise SystemExit("no non-control rows to score")

    control_bias = {
        "n": control_n,
        "fit_a_fraction": (control_fit_a / control_n) if control_n else None,
        "fit_b_fraction": (control_fit_b / control_n) if control_n else None,
        "fit_tie_fraction": (control_fit_tie / control_n) if control_n else None,
        "startable_disagreement_fraction": (control_disagree / control_n) if control_n else None,
    }

    result = {
        "metric": "6_human_actionability",
        "definition": "first step is startable in under two minutes, FINE_TUNING.md 5.1",
        "gate": METRIC_6_GATE,
        "n": counted,
        "model": model_startable / counted,
        "templates": template_startable / counted,
        "judged_by": _judged_by_label(judges),
        "human_judged": bool(args.human),
        "fit_not_a_spec_metric": {
            "note": (
                "Which breakdown is about THIS assignment. Feeds check 15's ship rule "
                "directly (scripts/verify/baselines.mjs): the model ships only if this "
                "beats templates_preferred, alongside the metric 6 gate above."
            ),
            "model_preferred": model_fit / counted,
            "templates_preferred": template_fit / counted,
            "tie": ties / counted,
        },
        "protocol": key.get("protocol", "per-row-blind-v2"),
        "seed": key.get("seed"),
        "controls": control_n,
        "control_bias": control_bias,
        "judge": sorted(judges) if len(judges) != 1 else next(iter(judges)),
        "session": sorted(sessions) if len(sessions) != 1 else next(iter(sessions)),
        "rows_dir": str(args.rows_dir),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    print(f"metric 6, startability, n={counted}, gate {METRIC_6_GATE}")
    print(f"  model      {result['model']:.3f}  {'PASS' if result['model'] >= METRIC_6_GATE else 'FAIL'}")
    print(f"  templates  {result['templates']:.3f}")
    print("\nfit, NOT a specification metric, reported for the human decision:")
    print(f"  model preferred      {model_fit / counted:.3f}")
    print(f"  templates preferred  {template_fit / counted:.3f}")
    print(f"  tie                  {ties / counted:.3f}")
    if control_n:
        print(f"\ncontrol rows (n={control_n}, excluded from the score above), judge side bias:")
        print(f"  fit preferred A      {control_bias['fit_a_fraction']:.3f}")
        print(f"  fit preferred B      {control_bias['fit_b_fraction']:.3f}")
        print(f"  fit tie              {control_bias['fit_tie_fraction']:.3f}")
        print(f"  startable disagreed  {control_bias['startable_disagreement_fraction']:.3f}")
    print(f"\nwrote {args.out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(
        description="Metric 6 (human actionability): build blind per-row judge files, "
        "then score the verdicts. See train/METRIC6_PROTOCOL.md."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    build_p = sub.add_parser(
        "build",
        help="build blind per-row judge files from a model sample and a templates sample",
    )
    build_p.add_argument("--model-sample", type=Path, default=MODEL_SAMPLE)
    build_p.add_argument("--template-sample", type=Path, default=TEMPLATE_SAMPLE)
    build_p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="RNG seed for side assignment")
    build_p.add_argument(
        "--controls",
        type=int,
        default=DEFAULT_CONTROLS,
        help="number of same-system control rows to insert (split model/templates)",
    )
    build_p.add_argument("--rows-dir", type=Path, default=ROWS_DIR)
    build_p.add_argument("--key", type=Path, default=KEY_FILE)
    build_p.set_defaults(func=cmd_build)

    score_p = sub.add_parser("score", help="score judge verdict files against the private key")
    score_p.add_argument("--rows-dir", type=Path, default=ROWS_DIR)
    score_p.add_argument("--key", type=Path, default=KEY_FILE)
    score_p.add_argument("--verdicts-dir", type=Path, default=VERDICTS_DIR)
    score_p.add_argument("--out", type=Path, default=RESULT)
    score_p.add_argument(
        "--human",
        action="store_true",
        help="mark the result human_judged: true (default false -- model judge)",
    )
    score_p.set_defaults(func=cmd_score)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
