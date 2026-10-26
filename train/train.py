"""Fine-tune the base model. Run --inspect and --overfit before a real run."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import torch
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback, set_seed
from trl import SFTConfig, SFTTrainer

TRAIN_DIR = Path(__file__).resolve().parent
DATA_DIR = TRAIN_DIR / "data"
OUT_DIR = TRAIN_DIR / "out"
RUNS_MD = TRAIN_DIR / "RUNS.md"

BASE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
DEVICE = "cpu"

# from docs/FINE_TUNING.md, except precision, which bench_dtype.py measured
SEED = 42
EPOCHS = 3
BATCH = 16
GRAD_ACCUM = 2
LEARNING_RATE = 2e-5
WARMUP_RATIO = 0.03
WEIGHT_DECAY = 0.01
MAX_LENGTH = 1024

DTYPES = {"fp32": torch.float32, "bf16": torch.bfloat16}


def load_split(path: Path) -> Dataset:
    """Reshape a `messages` jsonl into TRL's prompt-completion form, so completion_only_loss can mask the prompt."""
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() == "":
            continue
        messages = json.loads(line)["messages"]
        if len(messages) != 3 or messages[2]["role"] != "assistant":
            raise ValueError(f"{path.name}: expected [system, user, assistant], got {len(messages)}")
        rows.append({"prompt": messages[:2], "completion": messages[2:]})
    if not rows:
        raise ValueError(f"{path} is empty. Run train/build_dataset.py first.")
    return Dataset.from_list(rows)


def git_commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=TRAIN_DIR.parent,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.exists() else "missing"


class LossHistory(TrainerCallback):
    """Records the real loss curve for RUNS.md."""

    def __init__(self) -> None:
        self.train: list[tuple[int, float]] = []
        self.eval: list[tuple[int, float]] = []

    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return
        if "loss" in logs:
            self.train.append((state.global_step, float(logs["loss"])))
        if "eval_loss" in logs:
            self.eval.append((state.global_step, float(logs["eval_loss"])))


def build_trainer(
    args: argparse.Namespace,
    train_ds: Dataset,
    eval_ds: Dataset,
    output_dir: Path,
    *,
    epochs: float,
    max_steps: int,
    batch: int,
    grad_accum: int,
    learning_rate: float,
    eval_steps: int,
) -> tuple[SFTTrainer, LossHistory]:
    # transformers 5.x dropped warmup_ratio, so the 3% is counted in real optimizer steps
    per_epoch = math.ceil(len(train_ds) / (batch * grad_accum))
    total_steps = max_steps if max_steps > 0 else math.ceil(per_epoch * epochs)
    warmup_steps = max(1, math.ceil(total_steps * WARMUP_RATIO))
    print(f"steps/epoch {per_epoch}  total {total_steps}  warmup {warmup_steps}  eval every {eval_steps}")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base, dtype=DTYPES[args.dtype])
    model.to(args.device)

    config = SFTConfig(
        output_dir=str(output_dir),
        seed=args.seed,
        data_seed=args.seed,
        use_cpu=args.device == "cpu",
        num_train_epochs=epochs,
        max_steps=max_steps,
        per_device_train_batch_size=batch,
        per_device_eval_batch_size=batch,
        gradient_accumulation_steps=grad_accum,
        learning_rate=learning_rate,
        lr_scheduler_type="cosine",
        warmup_steps=warmup_steps,
        weight_decay=WEIGHT_DECAY,
        optim="adamw_torch",
        max_length=MAX_LENGTH,
        packing=False,
        # SmolLM2's template has no {% generation %} blocks, so assistant_only_loss cannot
        # work. the prompt-completion split masks the prompt with the template untouched
        completion_only_loss=True,
        assistant_only_loss=False,
        bf16=args.dtype == "bf16",
        logging_steps=args.logging_steps,
        eval_strategy="steps",
        eval_steps=eval_steps,
        # a 360M fp32 checkpoint with optimizer state is about 4.3 GB and the trainer keeps
        # three, more than the mac's disk could spare. v9 and v10 peaked at the final step anyway
        save_strategy="no" if getattr(args, "no_checkpoints", False) else "steps",
        save_steps=eval_steps,
        save_total_limit=2,
        load_best_model_at_end=not getattr(args, "no_checkpoints", False),
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        dataloader_num_workers=0,
        report_to=[],
        disable_tqdm=False,
    )

    history = LossHistory()
    trainer = SFTTrainer(
        model=model,
        args=config,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        processing_class=tokenizer,
        callbacks=[history],
    )
    return trainer, history


def inspect_batch(trainer: SFTTrainer, limit: int = 2) -> None:
    """Decode a training batch and print the tokens that carry loss. If the prompt shows up there, masking is wrong."""
    tokenizer = trainer.processing_class
    loader = trainer.get_train_dataloader()
    batch = next(iter(loader))

    input_ids = batch["input_ids"]
    labels = batch["labels"]
    print(f"batch keys: {sorted(batch.keys())}")
    print(f"input_ids {tuple(input_ids.shape)}  labels {tuple(labels.shape)}")

    for row in range(min(limit, input_ids.shape[0])):
        ids = input_ids[row]
        lab = labels[row]
        supervised = lab != -100
        print("\n" + "=" * 72)
        print(f"row {row}: {int(supervised.sum())} of {ids.numel()} tokens carry loss")
        print("--- full sequence, decoded ---")
        print(tokenizer.decode(ids, skip_special_tokens=False))
        print("--- tokens the loss is computed on ---")
        print(tokenizer.decode(ids[supervised], skip_special_tokens=False))
        first = int(supervised.nonzero()[0]) if supervised.any() else -1
        print(f"--- first supervised index: {first} ---")
        if first > 0:
            print("token before boundary: " + repr(tokenizer.decode(ids[first - 1 : first])))
            print("token at boundary:     " + repr(tokenizer.decode(ids[first : first + 1])))


def build_entry(
    args: argparse.Namespace,
    result,
    eval_loss: float,
    wall_seconds: float,
    train_ds: Dataset,
    eval_ds: Dataset,
    history: LossHistory,
    output_dir: Path,
    train_path: Path,
    val_path: Path,
) -> str:
    perplexity = math.exp(eval_loss) if eval_loss < 20 else float("inf")
    curve = "  ".join(f"{step}:{loss:.4f}" for step, loss in history.eval)
    return "\n".join(
        [
            "",
            f"## {args.run_name}",
            "",
            f"- commit `{git_commit()}`",
            f"- base `{args.base}`",
            f"- dtype `{args.dtype}`, device `{args.device}`, threads {torch.get_num_threads()}",
            f"- epochs {args.epochs}, batch {args.batch}, grad accum {args.grad_accum}, "
            f"effective {args.batch * args.grad_accum}",
            f"- lr {args.lr}, cosine, warmup {WARMUP_RATIO}, weight decay {WEIGHT_DECAY}, seed {args.seed}",
            f"- max length {MAX_LENGTH}, packing off, completion-only loss on"
            + (", no intermediate checkpoints (final save only)" if getattr(args, "no_checkpoints", False) else ""),
            f"- train {len(train_ds)}, val {len(eval_ds)}",
            f"- dataset hashes: train `{hash_file(train_path)}`, val `{hash_file(val_path)}`, "
            f"test `{hash_file(args.data_dir / 'test.jsonl')}`",
            f"- optimizer steps {int(result.global_step)}",
            f"- wall clock {wall_seconds / 60:.1f} min",
            f"- final train loss {result.training_loss:.4f}",
            f"- best eval loss {eval_loss:.4f} (perplexity {perplexity:.2f})",
            f"- eval curve: {curve}",
            f"- artifact `{output_dir / 'best'}`",
            "",
        ]
    )


def append_run(entry: str) -> None:
    if not RUNS_MD.exists():
        RUNS_MD.write_text(
            "# Runs\n\nOne entry per training run. Append only. "
            "`FINE_TUNING.md` section 4 requires the config, the git commit and "
            "the dataset hash for every run.\n",
            encoding="utf-8",
        )
    with RUNS_MD.open("a", encoding="utf-8") as handle:
        handle.write(entry)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true", help="decode one batch and exit")
    parser.add_argument("--overfit", action="store_true", help="32 examples, 50 steps")
    parser.add_argument("--run-name", default="v1")
    parser.add_argument("--base", default=BASE_MODEL, help="base model repo id")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], default=DEVICE, help="explicit device; never inferred")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="split directory; the smoke checks use a scratch copy")
    parser.add_argument("--dtype", choices=sorted(DTYPES), default="fp32")
    parser.add_argument("--epochs", type=float, default=EPOCHS)
    parser.add_argument("--batch", type=int, default=BATCH)
    parser.add_argument("--grad-accum", type=int, default=GRAD_ACCUM)
    parser.add_argument("--lr", type=float, default=LEARNING_RATE)
    parser.add_argument("--eval-steps", type=int, default=25)
    parser.add_argument("--logging-steps", type=int, default=5)
    parser.add_argument(
        "--no-checkpoints",
        action="store_true",
        help="save only the final model (no intermediate checkpoints, no best-of selection); for disk-bound runs",
    )
    return parser


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    args = build_parser().parse_args()

    if args.device == "mps" and args.dtype == "bf16":
        print("error: --dtype bf16 is not supported with --device mps", file=sys.stderr)
        return 1

    if args.device == "mps" and not torch.backends.mps.is_available():
        print("error: --device mps requested but torch.backends.mps.is_available() is False", file=sys.stderr)
        return 1

    if args.device == "cuda" and not torch.cuda.is_available():
        print("error: --device cuda requested but torch.cuda.is_available() is False", file=sys.stderr)
        return 1

    set_seed(args.seed)
    torch.manual_seed(args.seed)

    train_path = args.data_dir / "train.jsonl"
    val_path = args.data_dir / "val.jsonl"
    train_ds = load_split(train_path)
    eval_ds = load_split(val_path)
    print(f"train {len(train_ds)}  val {len(eval_ds)}  dtype {args.dtype}  threads {torch.get_num_threads()}")

    if args.overfit:
        # higher learning rate on purpose: this only asks whether masking and the template
        # let the model memorise 32 examples at all
        train_ds = train_ds.select(range(min(32, len(train_ds))))
        eval_ds = train_ds
        output_dir = OUT_DIR / "overfit32"
        trainer, history = build_trainer(
            args,
            train_ds,
            eval_ds,
            output_dir,
            epochs=-1,
            max_steps=50,
            batch=8,
            grad_accum=1,
            learning_rate=1e-4,
            eval_steps=10,
        )
    else:
        output_dir = OUT_DIR / args.run_name
        trainer, history = build_trainer(
            args,
            train_ds,
            eval_ds,
            output_dir,
            epochs=args.epochs,
            max_steps=-1,
            batch=args.batch,
            grad_accum=args.grad_accum,
            learning_rate=args.lr,
            eval_steps=args.eval_steps,
        )

    if args.inspect:
        inspect_batch(trainer)
        return 0

    started = time.time()
    result = trainer.train()
    wall_seconds = time.time() - started

    final_eval = trainer.evaluate()
    eval_loss = float(final_eval.get("eval_loss", float("nan")))

    if args.overfit:
        first = history.train[0][1] if history.train else float("nan")
        last = history.train[-1][1] if history.train else float("nan")
        print("\n=== overfit-32 sanity check ===")
        print(f"train loss: {first:.4f} at step {history.train[0][0]} -> {last:.4f} at step {history.train[-1][0]}")
        print(f"final eval loss on the same 32: {eval_loss:.4f}")
        curve = "  ".join(f"{step}:{loss:.3f}" for step, loss in history.train)
        print(f"curve: {curve}")
        if eval_loss < 0.05:
            print("VERDICT: PASS. Loss approaches zero; masking and template are right.")
            return 0
        print(
            "VERDICT: FAIL. Loss did not approach zero. Do not start the long run. "
            "Check the completion boundary with --inspect before anything else."
        )
        return 1

    trainer.save_model(str(output_dir / "best"))
    trainer.processing_class.save_pretrained(str(output_dir / "best"))

    entry = build_entry(
        args, result, eval_loss, wall_seconds, train_ds, eval_ds, history, output_dir, train_path, val_path
    )
    append_run(entry)
    print(entry)
    print(f"saved to {output_dir / 'best'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
