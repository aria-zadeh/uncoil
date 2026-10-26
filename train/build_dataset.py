"""Assemble, filter and split the fine-tuning dataset. The sealed test split is copied through, never inspected."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import prompt as prompt_mod
import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
SOURCE_DIR = TRAIN_DIR / "data_sources"
OUT_DIR = TRAIN_DIR / "data"

# gate minimums, and the target size
MIN_TRAIN = 1500
MIN_VAL = 200
MIN_TEST = 200
TARGET_TRAIN = 4000

# one model, three tasks, told apart by the system message
TASK_MIX = {"breakdown": 0.70, "extraction": 0.20, "simplification": 0.10}


@dataclass
class Sample:
    kind: str
    task: dict
    completion: str
    # "<dir>/<file>" and the index in it, only for the test-overlap drop diagnostic
    source_path: str = ""
    source_index: int = -1

    def messages(self) -> dict:
        if self.kind == "breakdown":
            built = prompt_mod.build_breakdown_prompt(
                prompt_mod.BreakdownInput(
                    title=self.task.get("title", ""),
                    subject=self.task.get("subject"),
                    description=self.task.get("description"),
                    due_phrase=self.task.get("duePhrase", "in 3 days"),
                    session_minutes=self.task.get("sessionMinutes", 30),
                )
            )
        elif self.kind == "extraction":
            built = prompt_mod.build_extraction_prompt(
                self.task.get("text", ""), self.task.get("today", "Monday")
            )
        elif self.kind == "simplification":
            built = prompt_mod.build_simplify_prompt(
                prompt_mod.SimplifyInput(
                    title=self.task.get("title", ""),
                    description=self.task.get("description"),
                )
            )
        else:
            raise ValueError(f"unknown kind: {self.kind}")

        return {
            "messages": [
                {"role": "system", "content": built.system},
                {"role": "user", "content": built.user},
                {"role": "assistant", "content": self.completion},
            ]
        }


def load_json_dir(directory: Path) -> list[Sample]:
    """Every .json batch file in a directory, in sorted order."""
    if not directory.exists():
        return []
    samples: list[Sample] = []
    for path in sorted(directory.glob("*.json")):
        if path.name.startswith("review-"):
            # review-<batch>.json holds blind-review verdicts, not data
            continue
        rel = f"{directory.name}/{path.name}"
        for index, record in enumerate(json.loads(path.read_text(encoding="utf-8"))):
            samples.append(
                Sample(
                    kind=record["kind"],
                    task=record["task"],
                    completion=record["completion"],
                    source_path=rel,
                    source_index=index,
                )
            )
    return samples


def load_jsonl_dir(directory: Path) -> list[Sample]:
    if not directory.exists():
        return []
    samples: list[Sample] = []
    for path in sorted(directory.glob("*.jsonl")):
        rel = f"{directory.name}/{path.name}"
        index = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip() == "":
                continue
            record = json.loads(line)
            samples.append(
                Sample(
                    kind=record["kind"],
                    task=record["task"],
                    completion=record["completion"],
                    source_path=rel,
                    source_index=index,
                )
            )
            index += 1
    return samples


def keep(sample: Sample) -> tuple[bool, str]:
    """Run the sample through the app's validator. Failures are dropped, never repaired, so training only sees outputs the app accepts."""
    result = validate_mod.verdict(sample.kind, sample.completion, sample.task)
    return result["ok"], result["code"]


def canonical_completion(sample: Sample) -> str:
    """Re-serialize so every target has one format, not its author's whitespace."""
    parsed = json.loads(validate_mod.strip_to_json(sample.completion))
    return json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


def _is_rft_source(source_path: str) -> bool:
    """True for a `synthesized/rft-*` file. Keyed on the basename so provenance shows in the file name."""
    return Path(source_path).name.startswith("rft-")


def dedupe(samples: list[Sample]) -> list[Sample]:
    """Drop repeated prompts, since one prompt with two answers reads as ambiguous. rft-* sources key on (prompt, completion) so their extra samples survive."""
    seen: set[str] = set()
    out: list[Sample] = []
    for sample in samples:
        prompt = json.dumps(sample.messages()["messages"][1], sort_keys=True, ensure_ascii=False)
        if _is_rft_source(sample.source_path):
            key = prompt + "\x1f" + sample.completion
        else:
            key = prompt
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        out.append(sample)
    return out


# the test split must not leak into training even as a near-duplicate. short
# completions like starter actions collide by chance, so they are not compared
COMPLETION_OVERLAP_MIN_LEN = 40
JACCARD_OVERLAP_THRESHOLD = 0.80


@dataclass(frozen=True)
class TestIndexEntry:
    """One test record's fingerprint, computed once."""

    test_id: int
    norm_prompt: str
    norm_completion: str
    prompt_words: frozenset[str]


@dataclass(frozen=True)
class Overlap:
    """Which check tripped, and the test record it matched."""

    reason: str  # "exact_prompt" | "exact_completion" | "jaccard_prompt"
    test_id: int


_WHITESPACE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Lowercase, whitespace-collapsed text, for exact-match comparison."""
    return _WHITESPACE.sub(" ", text.strip().lower())


def normalize_completion(text: str) -> str:
    """Sorted-key compact JSON, so formatting differences collide. Non-JSON falls back to text normalisation."""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError):
        return normalize_text(text)
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"))


def build_test_index(test_samples: list[Sample]) -> list[TestIndexEntry]:
    """Fingerprint every sealed test record. `test_id` is also the line number in test.jsonl."""
    index: list[TestIndexEntry] = []
    for test_id, sample in enumerate(test_samples):
        user_text = sample.messages()["messages"][1]["content"]
        index.append(
            TestIndexEntry(
                test_id=test_id,
                norm_prompt=normalize_text(user_text),
                norm_completion=normalize_completion(sample.completion),
                prompt_words=frozenset(validate_mod.words(user_text)),
            )
        )
    return index


def overlaps_test(record: Sample, test_index: list[TestIndexEntry]) -> Overlap | None:
    """The strongest overlap with a sealed test record: exact prompt, exact long completion, or prompt jaccard at the threshold."""
    user_text = record.messages()["messages"][1]["content"]
    norm_prompt = normalize_text(user_text)
    norm_completion = normalize_completion(record.completion)
    prompt_words = frozenset(validate_mod.words(user_text))

    for entry in test_index:
        if norm_prompt == entry.norm_prompt:
            return Overlap("exact_prompt", entry.test_id)

    if len(norm_completion) >= COMPLETION_OVERLAP_MIN_LEN:
        for entry in test_index:
            if (
                len(entry.norm_completion) >= COMPLETION_OVERLAP_MIN_LEN
                and norm_completion == entry.norm_completion
            ):
                return Overlap("exact_completion", entry.test_id)

    for entry in test_index:
        if validate_mod.jaccard(prompt_words, entry.prompt_words) >= JACCARD_OVERLAP_THRESHOLD:
            return Overlap("jaccard_prompt", entry.test_id)

    return None


# when several pool records implicate one test record, the most conclusive reason wins
_REASON_PRIORITY = {"exact_prompt": 0, "exact_completion": 1, "jaccard_prompt": 2}


def exclude_test_overlap(
    pool: list[Sample], test_index: list[TestIndexEntry]
) -> tuple[list[Sample], "Counter[str]", "Counter[str]", dict[int, str]]:
    """Drop pool records that overlap the test split. The contaminated-ids map covers the original pool, which earlier models trained on."""
    kept: list[Sample] = []
    dropped_by_reason: Counter[str] = Counter()
    dropped_by_source: Counter[str] = Counter()
    contamination: dict[int, str] = {}

    for sample in pool:
        overlap = overlaps_test(sample, test_index)
        if overlap is None:
            kept.append(sample)
            continue
        dropped_by_reason[overlap.reason] += 1
        source = sample.source_path or "?"
        dropped_by_source[source] += 1
        print(
            f"  dropped {source}[{sample.source_index}] "
            f"reason={overlap.reason} matched_test_id={overlap.test_id}"
        )
        existing = contamination.get(overlap.test_id)
        if existing is None or _REASON_PRIORITY[overlap.reason] < _REASON_PRIORITY[existing]:
            contamination[overlap.test_id] = overlap.reason

    return kept, dropped_by_reason, dropped_by_source, contamination


def read_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() != "":
            records.append(json.loads(line))
    return records


def find_overlap_violations(
    test_records: list[dict], combined: list[tuple[str, int, dict]]
) -> list[str]:
    """Exact prompt or completion matches between test and train+val. Shared by both checks so they cannot drift."""
    violations: list[str] = []
    for test_id, test_record in enumerate(test_records):
        test_prompt = normalize_text(test_record["messages"][1]["content"])
        test_completion = normalize_completion(test_record["messages"][2]["content"])
        for split, idx, record in combined:
            prompt = normalize_text(record["messages"][1]["content"])
            if prompt == test_prompt:
                violations.append(f"test[{test_id}] exact_prompt matches {split}[{idx}]")
                continue
            if len(test_completion) < COMPLETION_OVERLAP_MIN_LEN:
                continue
            completion = normalize_completion(record["messages"][2]["content"])
            if completion == test_completion:
                violations.append(f"test[{test_id}] exact_completion matches {split}[{idx}]")

    return violations


def verify_no_test_overlap_in_memory(
    test_samples: list[Sample], train_samples: list[Sample], val_samples: list[Sample]
) -> list[str]:
    """Check the splits before writing, so a contaminated build leaves nothing on disk."""
    test_records = [s.messages() for s in test_samples]
    combined: list[tuple[str, int, dict]] = [
        ("train", i, s.messages()) for i, s in enumerate(train_samples)
    ] + [("val", i, s.messages()) for i, s in enumerate(val_samples)]
    return find_overlap_violations(test_records, combined)


def verify_no_test_overlap(out_dir: Path) -> list[str]:
    """Re-check from the written files, to catch bugs in the write path itself."""
    test_records = read_jsonl(out_dir / "test.jsonl")
    combined: list[tuple[str, int, dict]] = [
        ("train", i, r) for i, r in enumerate(read_jsonl(out_dir / "train.jsonl"))
    ] + [("val", i, r) for i, r in enumerate(read_jsonl(out_dir / "val.jsonl"))]
    return find_overlap_violations(test_records, combined)


def write_jsonl(path: Path, samples: list[Sample]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for sample in samples:
            record = sample.messages()
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=OUT_DIR,
        help=(
            "Where to write train.jsonl, val.jsonl, test.jsonl and "
            "test-contaminated-ids.json. Defaults to train/data/. Point this "
            "at a scratch directory to run the full build -- including the "
            "sealed-test-overlap check -- without touching the committed "
            "dataset, e.g. while something else is reading train/data/."
        ),
    )
    args = parser.parse_args()
    rng = random.Random(args.seed)
    out_dir = args.out_dir

    anchor = load_json_dir(SOURCE_DIR / "anchor")
    adversarial = load_json_dir(SOURCE_DIR / "adversarial")
    # expand_compact.py turns synthesized batches into .json. both forms are read and dedupe() drops repeats
    synthesized = load_jsonl_dir(SOURCE_DIR / "synthesized") + load_json_dir(
        SOURCE_DIR / "synthesized"
    )

    print(f"loaded  anchor={len(anchor)}  adversarial={len(adversarial)}  synthesized={len(synthesized)}")

    pool: list[Sample] = []
    rejected: Counter[str] = Counter()
    for source_name, source in (
        ("anchor", anchor),
        ("adversarial", adversarial),
        ("synthesized", synthesized),
    ):
        kept_here = 0
        for sample in source:
            ok, code = keep(sample)
            if ok:
                sample.completion = canonical_completion(sample)
                pool.append(sample)
                kept_here += 1
            else:
                rejected[f"{source_name}:{code}"] += 1
        total = len(source)
        rate = (kept_here / total * 100) if total else 0.0
        print(f"  {source_name}: {kept_here}/{total} survived the validator ({rate:.1f}%)")

    if rejected:
        print("\nrejection reasons, most common first:")
        for reason, count in rejected.most_common(12):
            print(f"  {count:5d}  {reason}")

    before = len(pool)
    pool = dedupe(pool)
    if before != len(pool):
        print(f"\ndeduped {before - len(pool)} samples with a duplicate prompt")

    # copied through untouched. the index below only keeps it sealed from the pool
    test_samples = load_json_dir(SOURCE_DIR / "test")
    test_index = build_test_index(test_samples)

    print(f"\nchecking pool against the sealed test split ({len(test_index)} test records)...")
    pool_before_exclusion = len(pool)
    pool, dropped_by_reason, dropped_by_source, contamination = exclude_test_overlap(pool, test_index)
    total_dropped = pool_before_exclusion - len(pool)
    if total_dropped:
        print(f"\ndropped {total_dropped} pool record(s) that overlap train/data_sources/test/")
        print("  by reason:")
        for reason, count in dropped_by_reason.most_common():
            print(f"    {reason:18s} {count:5d}")
        print("  by source file:")
        for source, count in dropped_by_source.most_common():
            print(f"    {source:30s} {count:5d}")
    else:
        print("no overlap found")

    # v1 to v3 trained on a pool that overlapped these, so eval skips them for those runs
    contaminated_ids = [
        {"test_id": test_id, "reason": reason}
        for test_id, reason in sorted(contamination.items())
    ]
    out_dir.mkdir(parents=True, exist_ok=True)
    contaminated_path = out_dir / "test-contaminated-ids.json"
    contaminated_path.write_text(
        json.dumps(contaminated_ids, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"\nwrote {len(contaminated_ids)} contaminated test id(s) "
        f"(of {len(test_samples)} test records) to {contaminated_path}"
    )

    rng.shuffle(pool)
    val_count = max(MIN_VAL, int(len(pool) * 0.06))
    val_samples = pool[:val_count]
    train_samples = pool[val_count:]

    in_memory_violations = verify_no_test_overlap_in_memory(test_samples, train_samples, val_samples)
    if in_memory_violations:
        print("\nCONTAMINATION CHECK FAILED (in-memory, before writing): test overlaps train/val")
        for line in in_memory_violations[:50]:
            print(f"  {line}")
        if len(in_memory_violations) > 50:
            print(f"  ... and {len(in_memory_violations) - 50} more")
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(out_dir / "train.jsonl", train_samples)
    write_jsonl(out_dir / "val.jsonl", val_samples)
    write_jsonl(out_dir / "test.jsonl", test_samples)

    overlap_violations = verify_no_test_overlap(out_dir)
    if overlap_violations:
        print("\nCONTAMINATION CHECK FAILED (on-disk re-read): test overlaps train/val")
        for line in overlap_violations[:50]:
            print(f"  {line}")
        if len(overlap_violations) > 50:
            print(f"  ... and {len(overlap_violations) - 50} more")
        sys.exit(1)
    print(
        "\ncontamination check passed: zero exact-prompt / exact-completion "
        "overlap between test and train+val"
    )

    mix = Counter(s.kind for s in train_samples)
    print(f"\nsplits written to {out_dir}")
    print(f"  train {len(train_samples):5d}  (gate minimum {MIN_TRAIN}, target {TARGET_TRAIN})")
    print(f"  val   {len(val_samples):5d}  (gate minimum {MIN_VAL})")
    print(f"  test  {len(test_samples):5d}  (gate minimum {MIN_TEST})")
    print("\ntrain task mix:")
    for kind, share in TASK_MIX.items():
        actual = mix[kind] / len(train_samples) if train_samples else 0
        print(f"  {kind:15s} {mix[kind]:5d}  {actual * 100:5.1f}%  (target {share * 100:.0f}%)")

    print("\ndataset hashes, for the RUNS.md entry:")
    for name in ("train.jsonl", "val.jsonl", "test.jsonl"):
        print(f"  {name:12s} {hash_file(out_dir / name)}")

    shortfalls = []
    if len(train_samples) < MIN_TRAIN:
        shortfalls.append(f"train {len(train_samples)} < {MIN_TRAIN}")
    if len(val_samples) < MIN_VAL:
        shortfalls.append(f"val {len(val_samples)} < {MIN_VAL}")
    if len(test_samples) < MIN_TEST:
        shortfalls.append(f"test {len(test_samples)} < {MIN_TEST}")
    if shortfalls:
        print("\nBELOW THE GATE MINIMUM: " + "; ".join(shortfalls))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
