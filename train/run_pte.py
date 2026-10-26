"""Quick host smoke test for a .pte: does it load, and does the validator accept its output. Not a gate."""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval as eval_mod
import validate as validate_mod

MAX_NEW_TOKENS = 320


class ExecuTorchRunner:
    """The exported program through ExecuTorch's host runtime."""

    def __init__(self, pte: Path, tokenizer_path: Path) -> None:
        self.pte = pte
        self.method = ""
        self.runner = None

        from optimum.executorch import ExecuTorchModelForCausalLM  # type: ignore[import-not-found]
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path))

        # from_pretrained globs every .pte in the directory and breaks when there is more than one
        self._isolated_dir = tempfile.TemporaryDirectory(prefix="run_pte_")
        isolated_pte = Path(self._isolated_dir.name) / pte.name
        shutil.copy2(pte, isolated_pte)

        self.runner = ExecuTorchModelForCausalLM.from_pretrained(
            self._isolated_dir.name, file_name=pte.name, subfolder=""
        )
        self.method = "optimum.executorch ExecuTorchModelForCausalLM"

    def generate(self, built: "eval_mod.prompt_mod.Prompt") -> str:
        text = self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": built.system},
                {"role": "user", "content": built.user},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_len = len(self.tokenizer.encode(text))
        return self.runner.text_generation(  # type: ignore[union-attr]
            self.tokenizer,
            text,
            echo=False,
            max_seq_len=prompt_len + MAX_NEW_TOKENS,
        )


def breakdown_records(n: int) -> list[dict]:
    """The first `n` breakdown records of the sealed test split, in order."""
    records_all = eval_mod.load_test()
    records = [r for r in records_all if r["kind"] == "breakdown"]
    if not records:
        raise SystemExit("no breakdown records found in the sealed test split")
    return records[:n]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pte", type=Path, required=True, help="the .pte file to smoke test")
    parser.add_argument(
        "--tokenizer", type=Path, required=True, help="checkpoint directory holding the tokenizer"
    )
    parser.add_argument(
        "--n", type=int, default=8, help="number of breakdown records to run (default 8)"
    )
    parser.add_argument(
        "--out", type=Path, default=None, help="optional jsonl dump, one record per line"
    )
    args = parser.parse_args()

    if not args.pte.exists():
        raise SystemExit(f"missing {args.pte}")
    if not args.tokenizer.exists():
        raise SystemExit(f"missing {args.tokenizer}")

    records = breakdown_records(args.n)
    print(f"{len(records)} breakdown record(s) from the sealed test split")

    load_started = time.time()
    try:
        runner = ExecuTorchRunner(args.pte, args.tokenizer)
    except Exception as exc:  # noqa: BLE001 - report exactly what optimum.executorch raised
        print(f"failed to load program: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    load_seconds = time.time() - load_started
    print(f"runtime: {runner.method}")
    print(f"program load: {load_seconds:.1f}s")

    dump_rows: list[dict] = []
    seconds_list: list[float] = []
    verdicts: list[dict] = []

    print(f"\n{'idx':>3s} {'sec':>7s} {'steps':>5s}  {'verdict':22s}  output")
    for index, record in enumerate(records):
        built = eval_mod.build_prompt(record)
        started = time.time()
        raw = runner.generate(built)
        elapsed = time.time() - started
        seconds_list.append(elapsed)

        result = validate_mod.verdict("breakdown", raw, record["task"])
        verdicts.append(result)
        steps = eval_mod.parsed_steps(raw)
        step_count = len(steps) if steps is not None else 0

        preview = raw[:80].replace("\n", "\\n")
        print(f"{index:3d} {elapsed:7.1f} {step_count:5d}  {result['code']:22s}  {preview}")

        if args.out is not None:
            dump_rows.append(
                {
                    "index": index,
                    "task": record["task"],
                    "seconds": elapsed,
                    "step_count": step_count,
                    "verdict": result,
                    "completion": raw,
                }
            )

    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("w", encoding="utf-8", newline="\n") as handle:
            for row in dump_rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"\ndump  {args.out}")

    valid = sum(1 for v in verdicts if v["ok"])
    mean_seconds = statistics.mean(seconds_list) if seconds_list else 0.0
    reasons: dict[str, int] = {}
    for v in verdicts:
        if not v["ok"]:
            reasons[v["code"]] = reasons.get(v["code"], 0) + 1

    print(f"\nvalid {valid} of {len(records)}")
    print(f"mean {mean_seconds:.1f}s")
    if reasons:
        print("rejection reasons:")
        for code, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"  {count:3d}  {code}")

    return 0 if valid >= 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
