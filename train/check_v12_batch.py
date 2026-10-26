"""Check a v12 batch for the mix and conventions the validator does not enforce. Never reads the test split."""

from __future__ import annotations

import argparse
import glob
import random
import re
import sys
from collections import Counter
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent / "data_sources"
SESSIONS = {15, 20, 25, 30, 45, 60}
STEP_FIT = {15: (3, 4), 20: (4, 5), 25: (4, 5), 30: (5, 6), 45: (5, 7), 60: (5, 7)}
MIN_SUM_RATIO = 0.0
MAX_SUM_RATIO = 5.0
# clerical steps take a few minutes. dropped batches billed them at 20 to 35
CLERICAL_MAX_MINUTES = 15
CLERICAL_VERBS = {
    "open", "print", "put", "stack", "upload", "label", "sign", "hand", "tape", "glue", "staple",
    "pack", "load", "plug", "lay", "tune", "clear", "gather", "grab", "place", "attach", "insert",
    "tick", "circle", "number", "save", "email", "send", "export", "download", "turn", "close",
    "file", "stick", "pin", "hang", "date", "title", "name", "scan", "submit", "share", "text",
    "post", "return", "bring", "pick", "count", "set", "photograph",
}
# short but real work, so a looser cap
SHORT_WORK_MAX_MINUTES = 20
SHORT_WORK_VERBS = {"copy", "check", "compare", "record", "mark", "sort", "log", "find", "get", "collect"}
DUE_RE = re.compile(
    r"^(today|tomorrow|in (?:[2-9]|1[0-3]) days|next week|in 2 weeks|in 3 weeks|in a month|in [2-9]\d* months)$"
)
WEEKDAYS = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}


def records_of(path: Path) -> list[tuple[int, str]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.rstrip("\n")
        if line.strip() == "" or line.startswith("#"):
            continue
        out.append((len(out) + 1, line))
    return out


def other_sources(path: Path) -> set[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    for f in glob.glob(str(SOURCE_DIR / "*" / "*.txt")):
        p = Path(f)
        if p.parent.name == "test" or p.resolve() == path.resolve():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.startswith("b |") or line.startswith("x |"):
                parts = [x.strip() for x in line.split("|")]
                key = parts[1].lower() if parts[0] == "b" else parts[2].lower()
                seen.add((parts[0], key))
    return seen


def report_breakdowns(recs: list[tuple[int, str]], others: set) -> int:
    subj: Counter = Counter()
    sess: Counter = Counter()
    desc: Counter = Counter()
    titles: Counter = Counter()
    bad: list = []
    warn: list = []
    dups: list = []
    for i, line in recs:
        parts = [x.strip() for x in line.split("|")]
        if len(parts) not in (7, 8):
            bad.append((i, "fields", len(parts)))
            continue
        subj[parts[2]] += 1
        if parts[2] in ("", "~"):
            bad.append((i, "no subject"))
        session = int(parts[5]) if parts[5].isdigit() else -1
        sess[session] += 1
        if session not in SESSIONS:
            bad.append((i, "session not in set", session))
        if not DUE_RE.match(parts[4]):
            bad.append((i, "due phrase not in closed set", parts[4]))
        d = parts[3]
        desc["none" if d == "~" else ("paragraph" if len(d) > 120 else "line")] += 1
        steps = [c.strip() for c in parts[6].split(";") if c.strip()]
        try:
            mins = [int(c.rpartition(":")[2]) for c in steps]
        except ValueError:
            bad.append((i, "minutes parse", parts[6][:40]))
            continue
        n, total = len(steps), sum(mins)
        if session in STEP_FIT:
            lo, hi = STEP_FIT[session]
            if not (lo <= n <= hi):
                bad.append((i, f"{session} min session step count", n, f"want {lo} to {hi}"))
            ratio = total / session
            if not (MIN_SUM_RATIO <= ratio <= MAX_SUM_RATIO):
                bad.append((i, f"{session} min session sum ratio", round(ratio, 2), f"total {total}"))
        if steps and len(steps[0].rpartition(":")[0].strip()) < 8:
            bad.append((i, "first step under 8 characters"))
        for c, m in zip(steps, mins):
            first = c.rpartition(":")[0].strip().split()[0].lower() if c.rpartition(":")[0].strip() else ""
            if first in CLERICAL_VERBS and m > CLERICAL_MAX_MINUTES:
                bad.append((i, "clerical step over 15 min", f"{c.rpartition(':')[0].strip()[:50]}:{m}"))
            elif first in SHORT_WORK_VERBS and m > SHORT_WORK_MAX_MINUTES:
                warn.append((i, "short-work step over 20 min, reread it", f"{c.rpartition(':')[0].strip()[:50]}:{m}"))
        titles[parts[1].lower()] += 1
        if ("b", parts[1].lower()) in others:
            dups.append((i, parts[1]))
    print("subjects:", sorted(subj.items(), key=lambda x: -x[1]))
    print("sessions:", sorted(sess.items()))
    print("descriptions:", dict(desc))
    print("convention violations:", len(bad))
    for b in bad[:60]:
        print("  record", *b)
    print("warnings (not failing):", len(warn))
    for w in warn[:30]:
        print("  record", *w)
    print("duplicate titles against other sources:", len(dups))
    for d in dups[:20]:
        print("  record", *d)
    inner = [t for t, c in titles.items() if c > 1]
    print("duplicate titles inside the file:", len(inner), inner[:10])
    return len(bad) + len(dups) + len(inner)


def report_extractions(recs: list[tuple[int, str]], others: set) -> int:
    today: Counter = Counter()
    ntasks: Counter = Counter()
    bad: list = []
    dups: list = []
    lens: list = []
    tasks = 0
    with_subject = 0
    for i, line in recs:
        parts = [x.strip() for x in line.split("|")]
        if len(parts) != 4:
            bad.append((i, "fields", len(parts)))
            continue
        today[parts[1]] += 1
        if parts[1] not in WEEKDAYS:
            bad.append((i, "today not a weekday", parts[1]))
        lens.append(len(parts[2]))
        if len(parts[2]) > 780 or len(parts[2]) < 80:
            bad.append((i, "text length", len(parts[2])))
        if parts[3] == "-":
            ntasks[0] += 1
        else:
            ts = [t for t in parts[3].split(";") if t.strip()]
            ntasks[len(ts)] += 1
            for t in ts:
                tasks += 1
                if t.count(":") >= 2:
                    with_subject += 1
        if ("x", parts[2].lower()) in others:
            dups.append(i)
    print("today:", sorted(today.items()))
    print("task counts:", sorted(ntasks.items()))
    print(f"tasks {tasks}, with subject {with_subject} ({with_subject / max(tasks, 1):.2f})")
    if lens:
        print(f"text length min {min(lens)} max {max(lens)}")
    print("convention violations:", len(bad))
    for b in bad[:60]:
        print("  record", *b)
    print("duplicate texts against other sources:", len(dups), dups[:10])
    return len(bad) + len(dups)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--sample", type=int, default=0)
    parser.add_argument("--seed", type=int, default=1207)
    args = parser.parse_args()
    recs = records_of(args.path)
    kinds = Counter(line.split("|")[0].strip() for _, line in recs)
    print(f"file {args.path.name}: {len(recs)} records {dict(kinds)}")
    if args.sample:
        chosen = sorted(random.Random(args.seed).sample(recs, min(args.sample, len(recs))))
        for i, line in chosen:
            print(f"[{i}] {line}")
        return 0
    others = other_sources(args.path)
    problems = 0
    if kinds.get("b"):
        problems += report_breakdowns([r for r in recs if r[1].startswith("b |")], others)
    if kinds.get("x"):
        problems += report_extractions([r for r in recs if r[1].startswith("x |")], others)
    print(f"RESULT {'PASS' if problems == 0 else 'FAIL'} ({problems} problems)")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
