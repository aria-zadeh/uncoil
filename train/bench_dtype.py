"""Time a full fp32 and bf16 training step on this cpu, where bf16 may be emulated, to pick --dtype."""

from __future__ import annotations

import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
DEVICE = "cpu"
# measured corpus lengths: mean 144, p90 179, max 303. the collator pads to the
# longest row, so a max_length of 1024 is never actually seen
SEQ_LEN = 192
BATCH = 16
WARMUP = 2
STEPS = 4


def bench(dtype: torch.dtype, label: str, warmup: int = WARMUP, steps: int = STEPS) -> dict:
    print(f"--- {label} ---", flush=True)
    torch.manual_seed(42)
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=dtype)
    model.to(DEVICE)
    model.train()
    model.gradient_checkpointing_disable()

    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5, weight_decay=0.01)
    vocab = model.config.vocab_size
    input_ids = torch.randint(0, vocab, (BATCH, SEQ_LEN), device=DEVICE)
    labels = input_ids.clone()

    def one_step() -> float:
        started = time.perf_counter()
        out = model(input_ids=input_ids, labels=labels)
        out.loss.backward()
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        return time.perf_counter() - started

    for index in range(warmup):
        print(f"  {label} warmup {index + 1}/{warmup}...", flush=True)
        one_step()

    timings = []
    for index in range(steps):
        elapsed = one_step()
        timings.append(elapsed)
        print(f"  {label} step {index + 1}/{steps}: {elapsed:.2f}s", flush=True)
    per_step = sum(timings) / len(timings)
    tokens_per_second = (BATCH * SEQ_LEN) / per_step

    peak = torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0
    del model, optimizer
    return {
        "label": label,
        "seconds_per_step": per_step,
        "fastest": min(timings),
        "slowest": max(timings),
        "tokens_per_second": tokens_per_second,
        "peak": peak,
    }


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    print(f"torch {torch.__version__}  threads={torch.get_num_threads()}  device={DEVICE}")
    print(f"batch={BATCH}  seq_len={SEQ_LEN}  warmup={WARMUP}  timed_steps={STEPS}")
    print("timing a full training step: forward + backward + AdamW step\n")

    # four bf16 steps ran past 100 minutes while fp32 took seconds. one step shows the ratio
    results = [
        bench(torch.float32, "fp32"),
        bench(torch.bfloat16, "bf16", warmup=1, steps=1),
    ]

    print(f"{'dtype':8s} {'s/step':>9s} {'fastest':>9s} {'slowest':>9s} {'tok/s':>10s}")
    for r in results:
        print(
            f"{r['label']:8s} {r['seconds_per_step']:9.3f} {r['fastest']:9.3f} "
            f"{r['slowest']:9.3f} {r['tokens_per_second']:10.1f}"
        )

    fp32, bf16 = results
    ratio = bf16["seconds_per_step"] / fp32["seconds_per_step"]
    print(f"\nbf16 takes {ratio:.2f}x the time of fp32 per step")
    if ratio > 1.0:
        print("VERDICT: use fp32. bf16 is emulated on this CPU and is slower.")
    else:
        print("VERDICT: use bf16. It is genuinely faster here.")

    # project from measured throughput and the real mean padded length
    faster = min(results, key=lambda r: r["seconds_per_step"])
    mean_padded_tokens = 180
    for samples in (1700, 2500, 4000):
        tokens = samples * 3 * mean_padded_tokens
        hours = tokens / faster["tokens_per_second"] / 3600
        print(
            f"projection: {samples} samples x 3 epochs x ~{mean_padded_tokens} tok "
            f"= {tokens:,} tok = {hours:.2f} h in {faster['label']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
