"""Validate hand-authored sources after each batch, since build_dataset.py drops bad samples silently."""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate as v

SOURCE_DIR = Path(__file__).resolve().parent / "data_sources"


def main() -> int:
    failures = 0
    grand_total = 0
    for group in ("test", "anchor", "adversarial"):
        directory = SOURCE_DIR / group
        if not directory.exists():
            continue
        kinds: Counter[str] = Counter()
        total = 0
        bad: list[str] = []
        for path in sorted(directory.glob("*.json")):
            for index, record in enumerate(json.loads(path.read_text(encoding="utf-8"))):
                total += 1
                kinds[record["kind"]] += 1
                result = v.verdict(record["kind"], record["completion"], record["task"])
                if not result["ok"]:
                    label = record["task"].get("title") or record["task"].get("text") or ""
                    bad.append(
                        f"  {path.name}[{index}] {record['kind']:14s} {label[:44]:44s} "
                        f"{result['code']}: {result['reason']}"
                    )
        grand_total += total
        failures += len(bad)
        mix = "  ".join(f"{k}={n}" for k, n in sorted(kinds.items()))
        print(f"{group:12s} {total - len(bad):4d}/{total:4d} valid   {mix}")
        for line in bad:
            print(line)

    print(f"\ntotal hand-authored samples: {grand_total}, failures: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
