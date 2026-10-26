"""Rejection-sample completions from a checkpoint and keep the valid, non-duplicate ones as a new source file."""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval as eval_mod
import prompt as prompt_mod
import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = TRAIN_DIR / "data-v4pool" / "train.jsonl"
SYNTHESIZED_DIR = TRAIN_DIR / "data_sources" / "synthesized"

# wider than eval's app-matched 0.9 so repeated draws differ. Generator has no per-call
# knob, so this is applied by reassigning eval_mod.TOP_P
SAMPLE_TOP_P = 0.95

KIND_BY_SYSTEM = {
    prompt_mod.SYSTEM_BREAKDOWN: "breakdown",
    prompt_mod.SYSTEM_EXTRACTION: "extraction",
    prompt_mod.SYSTEM_SIMPLIFY: "simplification",
}


def _strip_prefix(line: str, prefix: str) -> str:
    if not line.startswith(prefix):
        raise ValueError(f"expected a line starting with {prefix!r}, got {line!r}")
    return line[len(prefix) :]


def parse_task(kind: str, user_text: str) -> dict:
    """Recover the task dict prompt.py rendered into a user turn. field() keeps values on one line, so splitting on newlines is safe."""
    lines = user_text.split("\n")
    if kind == "breakdown":
        title = _strip_prefix(lines[0], "Assignment: ")
        subject = _strip_prefix(lines[1], "Subject: ")
        description = _strip_prefix(lines[2], "Details: ")
        due_phrase = _strip_prefix(lines[3], "Due: ")
        session_minutes = int(_strip_prefix(lines[4], "Session length: "))
        return {
            "title": title,
            "subject": None if subject == prompt_mod.NONE else subject,
            "description": None if description == prompt_mod.NONE else description,
            "duePhrase": due_phrase,
            "sessionMinutes": session_minutes,
        }
    if kind == "extraction":
        if lines[0].startswith("Today: "):
            today = _strip_prefix(lines[0], "Today: ")
            text = _strip_prefix(lines[1], "Text: ")
            return {"text": text, "today": today}
        return {"text": _strip_prefix(lines[0], "Text: "), "today": "Monday"}
    if kind == "simplification":
        title = _strip_prefix(lines[0], "Assignment: ")
        description = _strip_prefix(lines[1], "Details: ")
        return {
            "title": title,
            "description": None if description == prompt_mod.NONE else description,
        }
    raise ValueError(f"unknown kind {kind}")


def load_pool(path: Path, kinds: set[str]) -> list[dict]:
    """Rebuild source-file records from a `messages`-format training file."""
    pool: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        messages = record["messages"]
        kind = KIND_BY_SYSTEM.get(messages[0]["content"])
        if kind is None or kind not in kinds:
            continue
        task = parse_task(kind, messages[1]["content"])
        pool.append({"kind": kind, "task": task, "completion": messages[2]["content"]})
    return pool


def candidate_key(kind: str, parsed: dict) -> tuple[str, ...] | str:
    """Breakdowns key on normalised step titles, so a minutes-only difference counts once. Other kinds key on the whole completion."""
    if kind == "breakdown":
        titles = [step["title"] for step in parsed["steps"]]
        return tuple(" ".join(validate_mod.words(t)) for t in titles)
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"))


def sample_record(
    generator: "eval_mod.Generator",
    kind: str,
    task: dict,
    original_completion: str,
    k: int,
    max_keep: int,
    base_seed: int,
    stats: Counter,
) -> list[str]:
    """Draw up to `k` completions and keep at most `max_keep` valid ones that repeat neither the original nor each other."""
    built = eval_mod.build_prompt({"kind": kind, "task": task})

    seen_keys: set = set()
    try:
        original_parsed = json.loads(validate_mod.strip_to_json(original_completion))
        seen_keys.add(candidate_key(kind, original_parsed))
    except (TypeError, ValueError, KeyError):
        pass

    kept: list[str] = []
    for draw in range(k):
        # Generator seeds per prompt, so an unchanged SEED would redraw the same sample.
        # this stays reproducible from (--seed, position, draw)
        eval_mod.SEED = base_seed + draw
        raw = generator.generate(built)
        stats["drawn"] += 1

        result = validate_mod.verdict(kind, raw, task)
        if not result["ok"]:
            stats[f"rejected:{result['code']}"] += 1
            continue
        stats["accepted"] += 1

        parsed = json.loads(validate_mod.strip_to_json(raw))
        key = candidate_key(kind, parsed)
        if key in seen_keys:
            stats["rejected:duplicate"] += 1
            continue
        seen_keys.add(key)
        kept.append(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
        if len(kept) >= max_keep:
            break
    return kept


def task_key(kind: str, task: dict) -> str:
    """A stable resume key, since the pool carries no ids."""
    return json.dumps([kind, task], sort_keys=True, ensure_ascii=False)


def progress_path_for(out_path: Path) -> Path:
    """Sidecar listing every prompt drawn from, so a resume also skips prompts that kept nothing."""
    return out_path.with_suffix(".progress.json")


def load_existing(out_path: Path) -> tuple[list[dict], set[str]]:
    """A prior run's output and every prompt it already tried, kept or not."""
    existing: list[dict] = []
    done: set[str] = set()
    if out_path.exists():
        existing = json.loads(out_path.read_text(encoding="utf-8"))
        done.update(task_key(r["kind"], r["task"]) for r in existing)
    progress_path = progress_path_for(out_path)
    if progress_path.exists():
        done.update(json.loads(progress_path.read_text(encoding="utf-8")))
    return existing, done


def write_output(out_path: Path, output: list[dict]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_progress(out_path: Path, done: set[str]) -> None:
    progress_path = progress_path_for(out_path)
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text(
        json.dumps(sorted(done), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="'base', or a fine-tuned checkpoint directory")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="messages-format training pool")
    parser.add_argument("--out", type=Path, default=None, help="source file to write; see module docstring")
    parser.add_argument("--k", type=int, default=8, help="completions sampled per prompt")
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--max-keep", type=int, default=2, help="accepted, distinct completions kept per prompt")
    parser.add_argument("--kinds", default="breakdown", help="comma-separated kinds to sample")
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], default="cpu")
    parser.add_argument("--limit", type=int, default=0, help="only the first N records, for a dry run")
    parser.add_argument("--seed", type=int, default=42)
    return parser


def default_out_path(model: str) -> Path:
    basename = Path(model.rstrip("/\\")).name or model
    return SYNTHESIZED_DIR / f"rft-{basename}-01.json"


def main() -> int:
    args = build_arg_parser().parse_args()
    kinds = {k.strip() for k in args.kinds.split(",") if k.strip()}
    out_path = args.out or default_out_path(args.model)

    pool = load_pool(args.data, kinds)
    if args.limit:
        pool = pool[: args.limit]
    print(f"loaded {len(pool)} candidate record(s) from {args.data} (kinds={sorted(kinds)})")

    output, done = load_existing(out_path)
    print(f"resuming from {out_path}: {len(output)} sample(s) already kept, {len(done)} prompt(s) covered")

    eval_mod.TEMPERATURE = args.temperature
    eval_mod.TOP_P = SAMPLE_TOP_P
    generator = eval_mod.Generator(args.model, args.device)

    stats: Counter = Counter()
    started = time.time()

    for index, record in enumerate(pool):
        key = task_key(record["kind"], record["task"])
        if key in done:
            stats["skipped_resume"] += 1
        else:
            base_seed = args.seed + index * 131
            kept = sample_record(
                generator, record["kind"], record["task"], record["completion"],
                args.k, args.max_keep, base_seed, stats,
            )
            stats["kept"] += len(kept)
            for completion in kept:
                output.append({"kind": record["kind"], "task": record["task"], "completion": completion})
            done.add(key)

        done_count = index + 1
        if done_count % 25 == 0 or done_count == len(pool):
            elapsed = time.time() - started
            print(f"  {done_count}/{len(pool)} records  {elapsed:.1f}s elapsed  kept so far {stats['kept']}")
            write_output(out_path, output)
            write_progress(out_path, done)

    write_output(out_path, output)
    write_progress(out_path, done)
    print_summary(pool, stats, time.time() - started, out_path)
    return 0


def print_summary(pool: list[dict], stats: Counter, elapsed: float, out_path: Path) -> None:
    print(f"\nrecords seen      {len(pool)}")
    print(f"samples drawn     {stats['drawn']}")
    print(f"accepted          {stats['accepted']}")
    print(f"kept              {stats['kept']}")
    print(f"skipped (resumed) {stats['skipped_resume']}")
    reasons = {
        name[len("rejected:") :]: count
        for name, count in stats.items()
        if name.startswith("rejected:")
    }
    if reasons:
        print("rejection reasons, most common first:")
        for name, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"  {count:5d}  {name}")
    print(f"elapsed seconds   {elapsed:.1f}")
    print(f"output            {out_path}")


if __name__ == "__main__":
    raise SystemExit(main())
