"""Emit the Python side of the cross-language parity checks as JSON on stdout.

Usage:
    python scripts/verify/emit_python_outputs.py prompts  <fixtures.json>
    python scripts/verify/emit_python_outputs.py verdicts <fixtures.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "train"))

import prompt as prompt_mod  # noqa: E402
import validate as validate_mod  # noqa: E402


def emit_prompts(fixtures: list[dict]) -> list[dict]:
    out: list[dict] = []
    for fixture in fixtures:
        kind = fixture["kind"]
        if kind == "breakdown":
            built = prompt_mod.build_breakdown_prompt(
                prompt_mod.BreakdownInput(
                    title=fixture["title"],
                    subject=fixture["subject"],
                    description=fixture["description"],
                    due_phrase=fixture["duePhrase"],
                    session_minutes=fixture["sessionMinutes"],
                )
            )
        elif kind == "extraction":
            built = prompt_mod.build_extraction_prompt(fixture["text"], fixture.get("today", "Monday"))
        elif kind == "simplify":
            built = prompt_mod.build_simplify_prompt(
                prompt_mod.SimplifyInput(
                    title=fixture["title"], description=fixture["description"]
                )
            )
        elif kind == "repair":
            base = prompt_mod.build_breakdown_prompt(
                prompt_mod.BreakdownInput(
                    title=fixture["title"],
                    subject=fixture["subject"],
                    description=fixture["description"],
                    due_phrase=fixture["duePhrase"],
                    session_minutes=fixture["sessionMinutes"],
                )
            )
            built = prompt_mod.build_repair_prompt(base, fixture["reason"])
        elif kind == "duePhrase":
            out.append({"id": fixture["id"], "system": "", "user": prompt_mod.relative_due_phrase(fixture["days"])})
            continue
        else:
            raise ValueError(f"unknown prompt fixture kind: {kind}")
        out.append({"id": fixture["id"], "system": built.system, "user": built.user})
    return out


def emit_verdicts(fixtures: list[dict]) -> list[dict]:
    out: list[dict] = []
    for fixture in fixtures:
        result = validate_mod.verdict(
            fixture["kind"], fixture["raw"], fixture.get("task")
        )
        out.append({"id": fixture["id"], **result})
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    mode, fixture_path = sys.argv[1], sys.argv[2]
    fixtures = json.loads(Path(fixture_path).read_text(encoding="utf-8"))

    if mode == "prompts":
        payload = emit_prompts(fixtures)
    elif mode == "verdicts":
        payload = emit_verdicts(fixtures)
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        return 2

    # the windows console is not utf-8 by default, and non-latin fixtures must survive
    sys.stdout.reconfigure(encoding="utf-8", newline="")
    json.dump(payload, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
