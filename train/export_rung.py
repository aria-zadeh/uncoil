"""Export one quantization rung of a checkpoint and write its recipe beside the .pte. Runs in train/.venv-export12."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export as export_mod


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--qlinear", default="8da8w", help="8da8w, 8da4w, or 'none'")
    parser.add_argument("--qembedding", default="none", help="4w, 8w, or 'none'")
    parser.add_argument("--dtype", default=None, help="bfloat16 / float16 for a half-precision rung")
    parser.add_argument("--max-seq-len", type=int, default=export_mod.MAX_SEQ_LEN)
    args = parser.parse_args()

    qlinear = None if args.qlinear in ("none", "") else args.qlinear
    qembedding = None if args.qembedding in ("none", "") else args.qembedding

    args.out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    pte = export_mod.try_optimum_python(
        args.model,
        args.out,
        args.max_seq_len,
        qlinear=qlinear,
        qembedding=qembedding,
        dtype=args.dtype,
    )
    if pte is None:
        print("export failed; see the traceback above")
        return 1

    # same shape export.py writes; parity.py --reference matched will not guess a recipe
    metadata = {
        "qlinear": qlinear,
        "qembedding": qembedding,
        "dtype": args.dtype,
        "max_seq_len": args.max_seq_len,
        "model": str(args.model),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    metadata_name = (
        "export-metadata.json"
        if pte.name == export_mod.ARTIFACT_NAME
        else f"export-metadata-{pte.stem}.json"
    )
    (pte.parent / metadata_name).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    size = pte.stat().st_size
    print(f"\nartifact  {pte}")
    print(f"size      {export_mod.human(size)}")
    print(f"recipe    {json.dumps(metadata)}")
    print(f"wall      {time.time() - started:.0f} s")

    # the app's runtime reads these constant methods at load
    try:
        from executorch.runtime import Runtime  # type: ignore[import-not-found]

        methods = sorted(Runtime.get().load_program(str(pte)).method_names)
        print(f"methods   {methods}")
        if "get_eos_ids" not in methods:
            print("FAIL: get_eos_ids missing; react-native-executorch 0.9.3 will refuse this program")
            return 1
    except Exception as exc:  # noqa: BLE001 - report whatever it raises
        print(f"method check skipped: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
