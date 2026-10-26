"""Score a checkpoint, a .pte or a predictions file on the sealed test split, with the app's validator and decoding."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import prompt as prompt_mod
import validate as validate_mod

TRAIN_DIR = Path(__file__).resolve().parent
TEST_SOURCE = TRAIN_DIR / "data_sources" / "test"
REPORT_DIR = TRAIN_DIR / "reports"

TEMPERATURE = 0.3
TOP_P = 0.9
MAX_NEW_TOKENS = 320
SEED = 42
# argmax instead of the app's sampling. a greedy row is a different system from a sampled one
GREEDY = False
# multiplicative penalty on every token already in the sequence, prompt included. 1.0 is
# off, and a penalised row is not comparable with an unpenalised one
REPETITION_PENALTY = 1.0

# the ship gates from docs/FINE_TUNING.md. never edit these to make a run pass
GATES = {
    "1_schema_first_try": (0.95, True),
    "2_schema_after_repair": (0.99, True),
    "3_step_count_in_range": (0.98, True),
    "4_steps_under_45_min": (0.98, True),
    "5_actionability": (0.92, True),
    "7_hallucination": (0.03, False),
    "8_duration_mape": (0.30, False),
    "9_format_leakage": (0.01, False),
    "10_repetition": (0.01, False),
}
METRIC_6_GATE = 0.85  # human-judged, scored separately


def load_test() -> list[dict]:
    """The sealed test split, read from its source so the raw task fields stay available."""
    records: list[dict] = []
    for path in sorted(TEST_SOURCE.glob("*.json")):
        records.extend(json.loads(path.read_text(encoding="utf-8")))
    if not records:
        raise SystemExit(f"no test records under {TEST_SOURCE}")
    return records


def load_records_file(path: Path) -> list[dict]:
    """Load a `messages`-format split other than the sealed one. Reports on it are diagnostics, never the gate."""
    import sample_rft as rft_mod

    records: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        messages = json.loads(line)["messages"]
        kind = rft_mod.KIND_BY_SYSTEM.get(messages[0]["content"])
        if kind is None:
            raise SystemExit(f"{path}: unknown system message in a record")
        task = rft_mod.parse_task(kind, messages[1]["content"])
        records.append({"kind": kind, "task": task, "completion": messages[2]["content"]})
    if not records:
        raise SystemExit(f"no records in {path}")
    return records


def load_excluded_positions(path: Path) -> set[int]:
    """Sealed-test positions to exclude, as plain ints or objects carrying `id`, `index`, `position` or `test_id`."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit(f"{path}: expected a JSON list, got {type(data).__name__}")
    positions: set[int] = set()
    for item in data:
        if isinstance(item, bool):
            raise SystemExit(f"{path}: boolean entry is not a valid position: {item!r}")
        if isinstance(item, int):
            positions.add(item)
            continue
        if isinstance(item, dict):
            for key in ("id", "index", "position", "test_id"):
                if key in item:
                    positions.add(int(item[key]))
                    break
            else:
                raise SystemExit(
                    f"{path}: entry has no id/index/position/test_id field: {item!r}"
                )
            continue
        raise SystemExit(f"{path}: unsupported entry {item!r}")
    return positions


def select_records(
    records_all: list[dict],
    kinds: str = "",
    exclude_positions: set[int] | None = None,
    limit: int = 0,
) -> tuple[list[dict], list[int], list[int], int]:
    """Apply --kinds and --exclude, then --limit. `kind_filtered_positions` is the order a --predictions file was written in."""
    if kinds:
        wanted = {k.strip() for k in kinds.split(",") if k.strip()}
        kind_filtered_positions = [i for i, r in enumerate(records_all) if r["kind"] in wanted]
    else:
        kind_filtered_positions = list(range(len(records_all)))

    exclude_positions = exclude_positions or set()
    kept_before_limit = [i for i in kind_filtered_positions if i not in exclude_positions]
    excluded_count = len(kind_filtered_positions) - len(kept_before_limit)

    keep_positions = kept_before_limit[:limit] if limit else kept_before_limit
    records = [records_all[i] for i in keep_positions]
    return records, keep_positions, kind_filtered_positions, excluded_count


def git_commit_hash() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=TRAIN_DIR,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def build_prompt(record: dict) -> prompt_mod.Prompt:
    task = record["task"]
    kind = record["kind"]
    if kind == "breakdown":
        return prompt_mod.build_breakdown_prompt(
            prompt_mod.BreakdownInput(
                title=task.get("title", ""),
                subject=task.get("subject"),
                description=task.get("description"),
                due_phrase=task.get("duePhrase", "in 3 days"),
                session_minutes=task.get("sessionMinutes", 30),
            )
        )
    if kind == "extraction":
        return prompt_mod.build_extraction_prompt(task.get("text", ""), task.get("today", "Monday"))
    if kind == "simplification":
        return prompt_mod.build_simplify_prompt(
            prompt_mod.SimplifyInput(title=task.get("title", ""), description=task.get("description"))
        )
    raise ValueError(f"unknown kind {kind}")


class Generator:
    """A Hugging Face causal LM, loaded lazily so --predictions skips the load."""

    def __init__(self, model_path: str, device: str = "cpu") -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.device = device
        resolved = "HuggingFaceTB/SmolLM2-135M-Instruct" if model_path == "base" else model_path
        self.name = resolved
        started = time.time()
        self.tokenizer = AutoTokenizer.from_pretrained(resolved)
        self.model = AutoModelForCausalLM.from_pretrained(resolved, dtype=torch.float32)
        self.model.to(self.device)
        self.model.eval()
        # added to the per-prompt seed. 0 reproduces an eval row, rehearse.py varies it per run
        self.seed_offset = 0
        print(f"loaded {resolved} in {time.time() - started:.1f}s")

    def generate(self, built: prompt_mod.Prompt) -> str:
        # seeded per prompt, not per run. with one run seed each draw depended on the records
        # before it, and the same model scored 0.943 and 0.841 on the same 145 breakdowns
        # across --kinds subsets. this makes the measurement repeatable, not the app deterministic
        digest = hashlib.sha256(f"{built.system}\n{built.user}".encode("utf-8")).digest()
        self.torch.manual_seed(SEED + int.from_bytes(digest[:4], "big") + self.seed_offset)

        messages = [
            {"role": "system", "content": built.system},
            {"role": "user", "content": built.user},
        ]
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(text, return_tensors="pt").to(self.device)
        sampling = (
            {"do_sample": False}
            if GREEDY
            else {"do_sample": True, "temperature": TEMPERATURE, "top_p": TOP_P}
        )
        if REPETITION_PENALTY != 1.0:
            sampling["repetition_penalty"] = REPETITION_PENALTY
        with self.torch.no_grad():
            out = self.model.generate(
                **inputs,
                max_new_tokens=MAX_NEW_TOKENS,
                pad_token_id=self.tokenizer.eos_token_id,
                **sampling,
            )
        return self.tokenizer.decode(
            out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True
        )


def top_p_filter(logits: "torch.Tensor", top_p: float) -> "torch.Tensor":
    """Nucleus filtering as the app does it. The top token always survives, and dropped logits become -inf."""
    import torch

    sorted_logits, sorted_indices = torch.sort(logits, descending=True)
    probs = torch.softmax(sorted_logits, dim=-1)
    cumulative = torch.cumsum(probs, dim=-1)
    # shifting the mask right by one keeps the position that first reaches top_p, and never drops position 0
    exceeded = cumulative >= top_p
    sorted_remove = torch.zeros_like(exceeded)
    sorted_remove[..., 1:] = exceeded[..., :-1]
    remove = torch.zeros_like(sorted_remove).scatter(-1, sorted_indices, sorted_remove)
    return logits.masked_fill(remove, float("-inf"))


def sample_token(logits: "torch.Tensor", *, temperature: float, top_p: float, greedy: bool) -> int:
    """One next-token id under the app's decoding policy. Apply any repetition penalty first."""
    import torch

    if greedy:
        return int(torch.argmax(logits, dim=-1).item())
    scaled = logits / temperature
    filtered = top_p_filter(scaled, top_p)
    probs = torch.softmax(filtered, dim=-1)
    return int(torch.multinomial(probs, num_samples=1).item())


def apply_repetition_penalty(logits: "torch.Tensor", token_ids: list[int], penalty: float) -> "torch.Tensor":
    """Hugging Face's repetition penalty on a copy: seen tokens' logits are divided if positive, multiplied if negative."""
    import torch

    logits = logits.clone()
    if not token_ids:
        return logits
    seen = torch.tensor(sorted(set(token_ids)), dtype=torch.long, device=logits.device)
    values = logits[seen]
    logits[seen] = torch.where(values < 0, values * penalty, values / penalty)
    return logits


class PteGenerator:
    """An exported .pte driven with the app's sampled decoding. Imports stay in __init__ since train/.venv has no executorch."""

    def __init__(self, pte_path: str, tokenizer_path: str, device: str = "cpu") -> None:
        import shutil
        import tempfile

        import torch
        from optimum.executorch import ExecuTorchModelForCausalLM  # type: ignore[import-not-found]
        from transformers import AutoTokenizer

        self.torch = torch
        self.device = device
        pte = Path(pte_path)
        self.name = f"pte:{pte}"
        self.tokenizer = AutoTokenizer.from_pretrained(tokenizer_path)

        started = time.time()
        # from_pretrained globs every .pte in the directory and breaks when there is more than one
        self._isolated_dir = tempfile.TemporaryDirectory(prefix="eval_pte_")
        isolated_pte = Path(self._isolated_dir.name) / pte.name
        shutil.copy2(pte, isolated_pte)
        self.runner = ExecuTorchModelForCausalLM.from_pretrained(
            self._isolated_dir.name, file_name=pte.name, subfolder=""
        )
        self.seed_offset = 0  # see Generator.__init__
        print(f"loaded {pte} in {time.time() - started:.1f}s")

        # the chat template ends a turn with <|im_end|>, which is not always the configured eos
        vocab = self.tokenizer.get_vocab()
        self.eos_ids: set[int] = set()
        if self.tokenizer.eos_token_id is not None:
            self.eos_ids.add(self.tokenizer.eos_token_id)
        for special in ("<|im_end|>", "<|endoftext|>"):
            if special in vocab:
                self.eos_ids.add(vocab[special])

    def _next_logits(self, token_id: int, position: int) -> "torch.Tensor":
        # a one-token step returns one row of logits, as (1, vocab) or (1, 1, vocab). the
        # reshape below handles either
        out = self.runner.forward(  # type: ignore[union-attr]
            input_ids=self.torch.tensor([token_id], dtype=self.torch.long, device=self.device).unsqueeze(0),
            cache_position=self.torch.tensor([position], dtype=self.torch.long, device=self.device),
        )
        vocab_size = out.shape[-1]
        return out.reshape(-1, vocab_size)[-1]

    def generate(self, built: prompt_mod.Prompt) -> str:
        # same per-prompt seeding as Generator
        digest = hashlib.sha256(f"{built.system}\n{built.user}".encode("utf-8")).digest()
        self.torch.manual_seed(SEED + int.from_bytes(digest[:4], "big") + self.seed_offset)

        messages = [
            {"role": "system", "content": built.system},
            {"role": "user", "content": built.user},
        ]
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        prompt_ids = list(self.tokenizer(text)["input_ids"])

        # restarting cache_position at 0 resets the kv cache, as parity.py relies on.
        # the installed runner has no reset_cache, but call it if a later one does
        reset = getattr(self.runner, "reset_cache", None)
        if callable(reset):
            reset()

        position = 0
        logits: "torch.Tensor | None" = None
        for token_id in prompt_ids:
            logits = self._next_logits(token_id, position)
            position += 1

        generated_ids: list[int] = []
        for _ in range(MAX_NEW_TOKENS):
            assert logits is not None  # prompt_ids is never empty (chat template)
            step_logits = logits
            if REPETITION_PENALTY != 1.0:
                step_logits = apply_repetition_penalty(
                    step_logits, prompt_ids + generated_ids, REPETITION_PENALTY
                )
            next_id = sample_token(step_logits, temperature=TEMPERATURE, top_p=TOP_P, greedy=GREEDY)
            if next_id in self.eos_ids:
                break
            generated_ids.append(next_id)
            logits = self._next_logits(next_id, position)
            position += 1

        return self.tokenizer.decode(generated_ids, skip_special_tokens=True)


def reference_total_minutes(record: dict) -> int | None:
    if record["kind"] != "breakdown":
        return None
    parsed = json.loads(record["completion"])
    return sum(int(s["minutes"]) for s in parsed["steps"])


def predicted_total_minutes(raw: str) -> int | None:
    stripped = validate_mod.strip_to_json(raw)
    if stripped is None:
        return None
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    steps = parsed.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    try:
        return sum(int(s["minutes"]) for s in steps)
    except (KeyError, TypeError, ValueError):
        return None


def has_format_leakage(raw: str) -> bool:
    """Anything outside the JSON object counts as leakage, fences included."""
    if "```" in raw:
        return True
    stripped = validate_mod.strip_to_json(raw)
    if stripped is None:
        return True
    return raw.strip() != stripped.strip()


def parsed_steps(raw: str) -> list[dict] | None:
    stripped = validate_mod.strip_to_json(raw)
    if stripped is None:
        return None
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    steps = parsed.get("steps")
    return steps if isinstance(steps, list) else None


def score(records: list[dict], predictions: list[str], repairs: list[str | None]) -> dict:
    """Every metric but the human-judged 6. A breakdown with no parseable steps fails 3, 4 and 5 rather than being skipped, but not 7."""
    total = len(records)
    breakdowns = [i for i, r in enumerate(records) if r["kind"] == "breakdown"]

    first_ok = 0
    repaired_ok = 0
    step_count_ok = 0
    minutes_ok = 0
    actionable_steps = 0
    total_steps = 0
    hallucinating = 0
    leaking = 0
    repeating = 0
    errors: dict[str, int] = {}
    percentage_errors: list[float] = []

    for index, record in enumerate(records):
        raw = predictions[index]
        kind = record["kind"]
        result = validate_mod.verdict(kind, raw, record["task"])
        if result["ok"]:
            first_ok += 1
            repaired_ok += 1
        else:
            errors[result["code"]] = errors.get(result["code"], 0) + 1
            second = repairs[index]
            if second is not None and validate_mod.verdict(kind, second, record["task"])["ok"]:
                repaired_ok += 1

        if has_format_leakage(raw):
            leaking += 1

        if kind != "breakdown":
            continue

        steps = parsed_steps(raw)
        if steps is None:
            # 3 and 4 already fail by omission. 5 needs an explicit failing step, or the
            # sample would leave the denominator and inflate the score
            total_steps += 1
            continue

        titles = [s.get("title") for s in steps if isinstance(s.get("title"), str)]
        minutes = [s.get("minutes") for s in steps if isinstance(s.get("minutes"), int)]

        if validate_mod.MIN_STEPS <= len(steps) <= validate_mod.MAX_STEPS:
            step_count_ok += 1
        if minutes and all(m <= validate_mod.MAX_MINUTES for m in minutes):
            minutes_ok += 1

        input_tokens = validate_mod._input_token_set(record["task"])
        for title in titles:
            total_steps += 1
            vague = validate_mod.matches_vague_phrase(title)
            if vague is None and validate_mod.starts_with_imperative(title):
                actionable_steps += 1
            if validate_mod.hallucinated_proper_noun(title, input_tokens) is not None:
                hallucinating += 1
                break

        normalized = [" ".join(validate_mod.words(t)) for t in titles]
        if len(normalized) != len(set(normalized)):
            repeating += 1

        reference = reference_total_minutes(record)
        predicted = predicted_total_minutes(raw)
        if reference and predicted:
            percentage_errors.append(abs(predicted - reference) / reference)

    breakdown_total = max(1, len(breakdowns))
    return {
        # 1, 2 and 9 count every record (n_all), the rest only breakdowns (n_breakdown).
        # n equals n_all and stays for older report readers
        "n": total,
        "n_all": total,
        "n_breakdown": len(breakdowns),
        "1_schema_first_try": first_ok / total,
        "2_schema_after_repair": repaired_ok / total,
        "3_step_count_in_range": step_count_ok / breakdown_total,
        "4_steps_under_45_min": minutes_ok / breakdown_total,
        "5_actionability": (actionable_steps / total_steps) if total_steps else 0.0,
        "7_hallucination": hallucinating / breakdown_total,
        "8_duration_mape": statistics.median(percentage_errors) if percentage_errors else 1.0,
        "9_format_leakage": leaking / total,
        "10_repetition": repeating / breakdown_total,
        "rejection_reasons": dict(sorted(errors.items(), key=lambda kv: -kv[1])),
    }


def print_table(label: str, metrics: dict) -> bool:
    print(f"\n=== {label} ===")
    print(f"scored {metrics['n']} samples ({metrics['n_breakdown']} breakdowns)")
    print(f"{'metric':26s} {'value':>8s} {'gate':>8s}  result")
    all_pass = True
    for key, (gate, higher_is_better) in GATES.items():
        value = metrics[key]
        ok = value >= gate if higher_is_better else value <= gate
        all_pass = all_pass and ok
        direction = ">=" if higher_is_better else "<="
        print(f"{key:26s} {value:8.3f} {direction}{gate:7.3f}  {'PASS' if ok else 'FAIL'}")
    if metrics["rejection_reasons"]:
        print("rejection reasons, most common first:")
        for code, count in list(metrics["rejection_reasons"].items())[:10]:
            print(f"  {count:5d}  {code}")
    print(f"\nmetric 6 (human actionability, gate {METRIC_6_GATE}) is not scored here.")
    return all_pass


def rescore_dump(args: argparse.Namespace) -> int:
    """Re-score an earlier run's completions under the current validator, without generating."""
    rows = [json.loads(line) for line in args.rescore_dump.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit(f"{args.rescore_dump}: empty dump")
    records = [{"kind": r["kind"], "task": r["task"], "completion": r.get("reference")} for r in rows]
    predictions = [r["completion"] for r in rows]
    repairs = [r.get("repair_completion") for r in rows]
    label = args.label or f"{args.rescore_dump.stem.replace('.dump', '')}-rescored"
    print(f"re-scoring {len(rows)} recorded completions from {args.rescore_dump}")

    metrics = score(records, predictions, repairs)
    passed = print_table(label, metrics)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    slug = label.replace("/", "_").replace("\\", "_").replace(":", "_")
    out = args.out or REPORT_DIR / f"{slug}.json"
    payload = {
        "label": label,
        "n": len(records),
        "gates": {k: {"gate": g, "higher_is_better": h} for k, (g, h) in GATES.items()},
        "metrics": {k: v for k, v in metrics.items() if k != "rejection_reasons"},
        "rejection_reasons": metrics["rejection_reasons"],
        "all_gates_pass": passed,
        "model_path": f"rescore:{args.rescore_dump}",
        "rescored_from": str(args.rescore_dump),
        "git_commit": git_commit_hash(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "harness": "rescore-dump",
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"report {out}")

    if args.dump:
        args.dump.parent.mkdir(parents=True, exist_ok=True)
        with args.dump.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                first = validate_mod.verdict(row["kind"], row["completion"], row["task"])
                repair_raw = row.get("repair_completion")
                second = validate_mod.verdict(row["kind"], repair_raw, row["task"]) if repair_raw is not None else None
                handle.write(json.dumps({**row, "verdict": first, "repair_verdict": second}, ensure_ascii=False) + "\n")
        print(f"dump  {args.dump}")
    return 0 if passed else 1


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", help="'base', or a path to a fine-tuned model")
    parser.add_argument("--predictions", type=Path, help="score an existing predictions jsonl")
    parser.add_argument(
        "--pte",
        type=Path,
        default=None,
        help=(
            "score an exported ExecuTorch .pte with the app's sampled decoding "
            "instead of a Hugging Face checkpoint. Mutually exclusive with "
            "--predictions; requires --model to name the checkpoint directory "
            "whose tokenizer and chat template are used."
        ),
    )
    parser.add_argument(
        "--rescore-dump",
        type=Path,
        default=None,
        help=(
            "re-score the completions and repair completions recorded in an "
            "earlier --dump jsonl under the current validator, without any "
            "generation; the report records rescored_from. This is how a row "
            "is brought under a widened lexicon (FINE_TUNING.md 5.1) without "
            "regenerating it."
        ),
    )
    parser.add_argument("--label", default=None)
    parser.add_argument("--limit", type=int, default=0, help="score only the first N, for smoke runs")
    parser.add_argument(
        "--metric6-sample-cap",
        type=int,
        default=50,
        help=(
            "rows written to <label>.metric6-sample.jsonl (default 50, the metric 6 "
            "and pairwise builders' shared prefix). Raised to 150 for the v11 versus "
            "v12 pairwise comparison (MODEL_HANDOFF_V12.md phase 4 step 5)."
        ),
    )
    parser.add_argument(
        "--kinds",
        default="",
        help=(
            "comma-separated kinds to score, e.g. 'breakdown'. Baseline 2 is "
            "templates, and services/templates.ts only decomposes assignments -- "
            "it does not extract tasks from text or simplify wording. Scoring it "
            "over the whole split would charge it for 30%% of the work it does not "
            "claim to do, make it look far worse than it is, and make check 15's "
            "'no worse than templates' comparison trivially easy. Section 5.2 "
            "expects templates to be near-perfect on metrics 1 to 5, which is only "
            "true on the breakdown subset. So all three baselines are compared "
            "there, on equal terms."
        ),
    )
    parser.add_argument(
        "--device",
        choices=["cpu", "mps", "cuda"],
        default="cpu",
        help="explicit device for the HF model; never inferred",
    )
    parser.add_argument("--no-repair", action="store_true", help="skip the metric 2 repair pass")
    parser.add_argument(
        "--greedy",
        action="store_true",
        help=(
            "argmax decoding instead of the app's temperature 0.3 / top-p 0.9 "
            "sampling. Diagnostic only: the report records decoding.greedy=true"
        ),
    )
    parser.add_argument(
        "--records",
        type=Path,
        default=None,
        help=(
            "score a messages-format jsonl (e.g. a pool's val.jsonl) instead of "
            "the sealed test source; diagnostic only, recorded as records_path"
        ),
    )
    parser.add_argument(
        "--repetition-penalty",
        type=float,
        default=1.0,
        help=(
            "Hugging Face repetition_penalty (1.0 off). Diagnostic: the report "
            "records decoding.repetition_penalty"
        ),
    )
    parser.add_argument(
        "--dump",
        type=Path,
        default=None,
        help=(
            "write every scored record (original test position, task, raw "
            "completion, repair completion, both verdicts, parsed step count) "
            "as jsonl, so failures can be read rather than counted"
        ),
    )
    parser.add_argument("--out", type=Path, default=None, help="where to write the report json")
    parser.add_argument(
        "--exclude",
        type=Path,
        default=None,
        help=(
            "JSON file listing sealed-test positions to drop before scoring and "
            "before any metric denominator, e.g. "
            "train/data/test-contaminated-ids.json. Positions are 0-based, in "
            "the original test.jsonl order (see load_excluded_positions)."
        ),
    )
    args = parser.parse_args()

    global GREEDY, REPETITION_PENALTY
    GREEDY = bool(args.greedy)
    REPETITION_PENALTY = float(args.repetition_penalty)

    if args.rescore_dump:
        if args.model or args.predictions or args.pte or args.records or args.exclude:
            parser.error("--rescore-dump takes only --label, --out and --dump")
        return rescore_dump(args)

    if args.pte and args.predictions:
        parser.error("--pte and --predictions are mutually exclusive")
    if args.pte and not args.model:
        parser.error(
            "--pte requires --model, naming the checkpoint directory whose "
            "tokenizer and chat template are used"
        )
    if not args.pte and bool(args.model) == bool(args.predictions):
        parser.error("give exactly one of --model or --predictions")

    if args.model:
        import torch

        if args.device == "mps" and not torch.backends.mps.is_available():
            print("error: --device mps requested but torch.backends.mps.is_available() is False", file=sys.stderr)
            return 1
        if args.device == "cuda" and not torch.cuda.is_available():
            print("error: --device cuda requested but torch.cuda.is_available() is False", file=sys.stderr)
            return 1

    records_all = load_records_file(args.records) if args.records else load_test()
    excluded_positions: set[int] = set()
    if args.exclude:
        excluded_positions = load_excluded_positions(args.exclude)

    records, keep_positions, kind_filtered_positions, excluded_count = select_records(
        records_all, kinds=args.kinds, exclude_positions=excluded_positions, limit=args.limit
    )
    if not records:
        raise SystemExit(
            f"no test records remain (kinds={args.kinds!r}, exclude={args.exclude}, "
            f"limit={args.limit})"
        )
    label = args.label or (args.model or str(args.predictions))
    print(
        f"test split: {len(records)} records from {TEST_SOURCE}"
        + (f" ({excluded_count} excluded via {args.exclude})" if args.exclude else "")
    )

    predictions: list[str] = []
    repairs: list[str | None] = [None] * len(records)

    if args.predictions:
        lines = [
            line for line in args.predictions.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        # a predictions file covers every kind-matched record in original order, ignoring
        # --exclude, so positions are looked up in that order rather than by row count
        position_lookup = {orig_i: row for row, orig_i in enumerate(kind_filtered_positions)}
        needed_rows = [position_lookup[i] for i in keep_positions]
        min_rows = max(needed_rows) + 1 if needed_rows else 0
        if len(lines) < min_rows:
            raise SystemExit(f"{args.predictions} has {len(lines)} rows, need at least {min_rows}")
        predictions = [json.loads(lines[row])["completion"] for row in needed_rows]
    else:
        generator = (
            PteGenerator(str(args.pte), args.model, args.device)
            if args.pte
            else Generator(args.model, args.device)
        )
        started = time.time()
        for index, record in enumerate(records):
            built = build_prompt(record)
            raw = generator.generate(built)
            predictions.append(raw)

            if not args.no_repair:
                result = validate_mod.verdict(record["kind"], raw, record["task"])
                if not result["ok"]:
                    repairs[index] = generator.generate(
                        prompt_mod.build_repair_prompt(built, result["reason"])
                    )

            done = index + 1
            if done % 10 == 0 or done == len(records):
                rate = (time.time() - started) / done
                print(f"  {done}/{len(records)}  {rate:.1f}s/sample  eta {(len(records) - done) * rate / 60:.1f} min")

    metrics = score(records, predictions, repairs)
    passed = print_table(label, metrics)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    slug = label.replace("/", "_").replace("\\", "_").replace(":", "_")
    out = args.out or REPORT_DIR / f"{slug}.json"
    payload = {
        "label": label,
        "n": len(records),
        "gates": {k: {"gate": g, "higher_is_better": h} for k, (g, h) in GATES.items()},
        "metrics": {k: v for k, v in metrics.items() if k != "rejection_reasons"},
        "rejection_reasons": metrics["rejection_reasons"],
        "all_gates_pass": passed,
        "model_path": (
            f"pte:{args.pte}" if args.pte else (args.model if args.model else f"predictions:{args.predictions}")
        ),
        "git_commit": git_commit_hash(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "excluded_count": excluded_count,
        "excluded_path": str(args.exclude) if args.exclude else None,
        "harness": "per-prompt-seed",
        "records_path": str(args.records) if args.records else None,
        "decoding": {
            "greedy": GREEDY,
            "temperature": None if GREEDY else TEMPERATURE,
            "top_p": None if GREEDY else TOP_P,
            "max_new_tokens": MAX_NEW_TOKENS,
            "repetition_penalty": REPETITION_PENALTY,
            "repair": not args.no_repair,
            "backend": "executorch" if args.pte else "huggingface",
        },
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    if args.dump:
        args.dump.parent.mkdir(parents=True, exist_ok=True)
        with args.dump.open("w", encoding="utf-8", newline="\n") as handle:
            for index, (position, record) in enumerate(zip(keep_positions, records)):
                raw = predictions[index]
                first = validate_mod.verdict(record["kind"], raw, record["task"])
                repair_raw = repairs[index]
                second = (
                    validate_mod.verdict(record["kind"], repair_raw, record["task"])
                    if repair_raw is not None
                    else None
                )
                steps = parsed_steps(raw) if record["kind"] == "breakdown" else None
                handle.write(
                    json.dumps(
                        {
                            "position": position,
                            "kind": record["kind"],
                            "task": record["task"],
                            "reference": record.get("completion"),
                            "completion": raw,
                            "verdict": first,
                            "step_count": None if steps is None else len(steps),
                            "repair_completion": repair_raw,
                            "repair_verdict": second,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        print(f"dump  {args.dump}")

    sample = REPORT_DIR / f"{slug}.metric6-sample.jsonl"
    with sample.open("w", encoding="utf-8", newline="\n") as handle:
        for record, raw in list(zip(records, predictions))[: args.metric6_sample_cap]:
            handle.write(
                json.dumps({"kind": record["kind"], "task": record["task"], "completion": raw}, ensure_ascii=False)
                + "\n"
            )

    print(f"\nreport  {out}")
    print(f"metric 6 sample  {sample}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
