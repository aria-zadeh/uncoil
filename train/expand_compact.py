"""Expand the compact hand-authored .txt sources into validated dataset JSON.

    b | title | subject | description | duePhrase | sessionMinutes | step:5 ; step:20 [ | starterAction ]
    x | today | source text | title:dueInDays[:subject] ; ...    (no tasks: -)
    s | original title | original description | new title | explanation

`~` is null, and dueInDays counts from `today`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate as validate_mod

SOURCE_DIR = Path(__file__).resolve().parent / "data_sources"

NULL = "~"


def _field(value: str) -> str | None:
    value = value.strip()
    return None if value == NULL or value == "" else value


def parse_breakdown(parts: list[str]) -> dict:
    if len(parts) not in (7, 8):
        raise ValueError(f"breakdown needs 7 or 8 fields, got {len(parts)}")
    title, subject, description, due, session, steps_raw = parts[1:7]

    steps = []
    for chunk in steps_raw.split(";"):
        chunk = chunk.strip()
        if chunk == "":
            continue
        step_title, _, minutes = chunk.rpartition(":")
        steps.append({"title": step_title.strip(), "minutes": int(minutes)})

    starter = parts[7].strip() if len(parts) == 8 and parts[7].strip() else steps[0]["title"]

    return {
        "kind": "breakdown",
        "task": {
            "title": title.strip(),
            "subject": _field(subject),
            "description": _field(description),
            "duePhrase": due.strip(),
            "sessionMinutes": int(session),
        },
        "completion": json.dumps(
            {"steps": steps, "starterAction": starter}, ensure_ascii=False, separators=(",", ":")
        ),
    }


WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def parse_extraction(parts: list[str]) -> dict:
    if len(parts) == 4:
        today, text, tasks_raw = parts[1].strip(), parts[2], parts[3]
        if today not in WEEKDAYS:
            raise ValueError(f"extraction today must be a weekday name, got {today!r}")
    elif len(parts) == 3:
        # older lines have no day. they were labelled as read on a monday, the builder's default too
        today, text, tasks_raw = "Monday", parts[1], parts[2]
    else:
        raise ValueError(f"extraction needs 3 or 4 fields, got {len(parts)}")

    tasks = []
    if tasks_raw.strip() != "-":
        for chunk in tasks_raw.split(";"):
            chunk = chunk.strip()
            if chunk == "":
                continue
            bits = chunk.split(":")
            entry = {"title": bits[0].strip(), "dueInDays": int(bits[1])}
            if len(bits) > 2 and bits[2].strip():
                entry["subject"] = bits[2].strip()
            tasks.append(entry)

    return {
        "kind": "extraction",
        "task": {"text": text.strip(), "today": today},
        "completion": json.dumps({"tasks": tasks}, ensure_ascii=False, separators=(",", ":")),
    }


def parse_simplification(parts: list[str]) -> dict:
    if len(parts) != 5:
        raise ValueError(f"simplification needs 5 fields, got {len(parts)}")
    title, description, new_title, explanation = parts[1:5]
    return {
        "kind": "simplification",
        "task": {"title": title.strip(), "description": _field(description)},
        "completion": json.dumps(
            {"title": new_title.strip(), "explanation": explanation.strip()},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }


PARSERS = {"b": parse_breakdown, "x": parse_extraction, "s": parse_simplification}


def expand_file(path: Path) -> tuple[list[dict], list[str]]:
    records: list[dict] = []
    errors: list[str] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        parts = line.split("|")
        kind = parts[0].strip()
        parser = PARSERS.get(kind)
        if parser is None:
            errors.append(f"{path.name}:{number} unknown kind {kind!r}")
            continue
        try:
            record = parser(parts)
        except (ValueError, IndexError) as exc:
            errors.append(f"{path.name}:{number} {exc}")
            continue

        result = validate_mod.verdict(record["kind"], record["completion"], record["task"])
        if not result["ok"]:
            label = record["task"].get("title") or record["task"].get("text") or ""
            errors.append(
                f"{path.name}:{number} {label[:44]!r} {result['code']}: {result['reason']}"
            )
            continue
        records.append(record)
    return records, errors


def main() -> int:
    # windows consoles default to cp1252 and would crash printing a non-latin title
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--all", action="store_true", help="expand every .txt under data_sources/")
    args = parser.parse_args()

    paths = list(args.paths)
    if args.all:
        paths = sorted(SOURCE_DIR.rglob("*.txt"))
    if not paths:
        parser.error("give a path or --all")

    total_errors = 0
    for path in paths:
        records, errors = expand_file(path)
        out = path.with_suffix(".json")
        out.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        status = "OK " if not errors else "ERR"
        print(f"{status} {path.name}: {len(records)} valid -> {out.name}")
        for error in errors:
            print(f"      {error}")
        total_errors += len(errors)

    if total_errors:
        print(f"\n{total_errors} line(s) rejected. They were NOT written; fix and re-run.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
