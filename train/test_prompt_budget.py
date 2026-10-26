"""Check that clampNotes' per-character token estimate never undercounts the real tokenizer, so a clamped prompt plus the answer fits the context."""

from __future__ import annotations

import os
import random
import re
from pathlib import Path

import pytest

import prompt as p

# offline: the tokenizer comes from the local cache that download_base.py fills
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

TRAIN_DIR = Path(__file__).resolve().parent
REPO_ROOT = TRAIN_DIR.parent
GENERATION_PIPELINE_TS = REPO_ROOT / "services" / "generationPipeline.ts"

BASE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
FALLBACK_MODEL = TRAIN_DIR / "out" / "v2" / "best"

# fixed by the export config and the app's decoding settings
MAX_SEQ_LEN = 1024
MAX_NEW_TOKENS = 320
MIN_NOTES_TOKEN_BUDGET = 450  # a floor: raise weights, never lower the budget below this


def read_notes_token_budget() -> int:
    text = GENERATION_PIPELINE_TS.read_text(encoding="utf-8")
    match = re.search(r"export const NOTES_TOKEN_BUDGET\s*=\s*(\d+)", text)
    assert match is not None, (
        "NOTES_TOKEN_BUDGET not found in services/generationPipeline.ts -- "
        "did the export or the constant name change? This file reads it by "
        "regex on purpose, so the Python and TypeScript budgets cannot "
        "silently drift apart; update the regex here if the name changed "
        "deliberately."
    )
    return int(match.group(1))


def read_notes_weights() -> dict[str, float]:
    text = GENERATION_PIPELINE_TS.read_text(encoding="utf-8")
    block_match = re.search(
        r"export const NOTES_WEIGHTS\s*=\s*\{(.*?)\}\s*as const;", text, re.DOTALL
    )
    assert block_match is not None, (
        "NOTES_WEIGHTS not found in services/generationPipeline.ts -- did the "
        "export, the constant name, or the `as const` suffix change? This "
        "file reads the weight table by regex on purpose."
    )
    body = block_match.group(1)
    pairs = re.findall(r"(\w+)\s*:\s*([\d.]+)\s*,", body)
    assert pairs, "NOTES_WEIGHTS was found but no `key: number,` pairs parsed out of it."
    weights = {key: float(value) for key, value in pairs}
    expected_keys = {
        "whitespace",
        "asciiLetter",
        "asciiDigit",
        "asciiPunct",
        "astral",
        "otherBmp",
    }
    assert set(weights) == expected_keys, (
        f"NOTES_WEIGHTS keys changed: parsed {sorted(weights)}, expected "
        f"{sorted(expected_keys)}. Update this file's classifier to match."
    )
    return weights


NOTES_TOKEN_BUDGET = read_notes_token_budget()
NOTES_WEIGHTS = read_notes_weights()

assert NOTES_TOKEN_BUDGET >= MIN_NOTES_TOKEN_BUDGET, (
    f"NOTES_TOKEN_BUDGET is {NOTES_TOKEN_BUDGET}, below the floor of "
    f"{MIN_NOTES_TOKEN_BUDGET}. If a shape below is failing, raise its "
    "weight in services/generationPipeline.ts instead of lowering the budget."
)


# port of clampNotes / estimateTokensUpperBound in services/generationPipeline.ts. walks by
# code point and cuts at the last whitespace before the estimate overflows, else hard

def classify_code_point(ch: str) -> str:
    if re.match(r"\s", ch):
        return "whitespace"
    cp = ord(ch)
    if cp <= 0x7F:
        if (0x41 <= cp <= 0x5A) or (0x61 <= cp <= 0x7A):
            return "asciiLetter"
        if 0x30 <= cp <= 0x39:
            return "asciiDigit"
        return "asciiPunct"
    if cp > 0xFFFF:
        return "astral"
    return "otherBmp"


def estimate_tokens_upper_bound(text: str) -> float:
    return sum(NOTES_WEIGHTS[classify_code_point(ch)] for ch in text)


def clamp_notes(text: str) -> str:
    if estimate_tokens_upper_bound(text) <= NOTES_TOKEN_BUDGET:
        return text

    total = 0.0
    offset = 0
    last_word_break = -1
    in_whitespace_run = False

    for ch in text:
        weight = NOTES_WEIGHTS[classify_code_point(ch)]
        if total + weight > NOTES_TOKEN_BUDGET:
            cut = last_word_break if last_word_break > 0 else offset
            return text[:cut]
        if weight == 0:
            if not in_whitespace_run:
                last_word_break = offset
                in_whitespace_run = True
        else:
            in_whitespace_run = False
        total += weight
        offset += 1
    return text


@pytest.fixture(scope="module")
def tokenizer():
    from transformers import AutoTokenizer

    try:
        return AutoTokenizer.from_pretrained(BASE_MODEL)
    except Exception:
        # the same SmolLM2 tokenizer, saved beside the fine-tuned weights
        return AutoTokenizer.from_pretrained(str(FALLBACK_MODEL))


def real_tokens_of(tokenizer, text: str) -> int:
    return len(tokenizer(text, return_tensors=None)["input_ids"])


def total_prompt_tokens(tokenizer, title: str, description: str) -> int:
    built = p.build_breakdown_prompt(
        p.BreakdownInput(
            title=title,
            subject="English",
            description=description,
            due_phrase="in 3 days",
            session_minutes=30,
        )
    )
    messages = [
        {"role": "system", "content": built.system},
        {"role": "user", "content": built.user},
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return real_tokens_of(tokenizer, text)


TITLE_80 = "W" * 80


ENGLISH_PARAGRAPH = (
    "Read the assigned chapter carefully and take notes on the main "
    "arguments the author makes. Then write a short response explaining "
    "whether you agree with the author's conclusion and why, using at "
    "least two examples from the text to support your answer. "
)
CJK_PARAGRAPH = "这是一个关于学校作业的段落,用于测试文本长度和分词器的行为。请仔细阅读并总结要点。"
ACCENTED_PARAGRAPH = (
    "Voici un paragraphe avec des caracteres accentues comme e, e, a, c, i, "
    "o, u, utilise pour tester la facon dont le tokenizer gere le texte "
    "francais avec des accents reels: é è à ç ï ô ù. "
)
MARKDOWN_PARAGRAPH = (
    "**Assignment**: read pages 10-20, write a _one-page_ summary. "
    "See [rubric](http://example.com/rubric) for details! Steps:\n"
    "1. Read the chapter.\n2. Write the summary.\n3. Submit it.\n"
)


def _repeat_to_at_least(unit: str, n_chars: int) -> str:
    reps = (n_chars // max(len(unit), 1)) + 2
    return (unit * reps)[:n_chars]


# far over budget so clamp_notes has real cutting to do
WELL_OVER_BUDGET_CHARS = int(NOTES_TOKEN_BUDGET) * 30 + 10_000


def shape_english_prose() -> str:
    return _repeat_to_at_least(ENGLISH_PARAGRAPH, WELL_OVER_BUDGET_CHARS)


def shape_dense_with_whitespace() -> str:
    return _repeat_to_at_least("a1b2 ", WELL_OVER_BUDGET_CHARS)


def shape_dense_no_whitespace() -> str:
    return _repeat_to_at_least("a1b2", WELL_OVER_BUDGET_CHARS)


def shape_astral_emoji() -> str:
    # one code point here, a surrogate pair in js. both sides walk by code point
    return "\U0001F600" * (WELL_OVER_BUDGET_CHARS // 2)


def shape_cjk_prose() -> str:
    return _repeat_to_at_least(CJK_PARAGRAPH, WELL_OVER_BUDGET_CHARS)


def shape_accented_latin() -> str:
    return _repeat_to_at_least(ACCENTED_PARAGRAPH, WELL_OVER_BUDGET_CHARS)


def shape_mixed_markdown() -> str:
    return _repeat_to_at_least(MARKDOWN_PARAGRAPH, WELL_OVER_BUDGET_CHARS)


SHAPES = {
    "english_prose": shape_english_prose,
    "dense_with_whitespace": shape_dense_with_whitespace,
    "dense_no_whitespace": shape_dense_no_whitespace,
    "astral_emoji": shape_astral_emoji,
    "cjk_prose": shape_cjk_prose,
    "accented_latin": shape_accented_latin,
    "mixed_markdown": shape_mixed_markdown,
}


def test_notes_token_budget_and_weights_were_read_from_the_ts_source():
    assert NOTES_TOKEN_BUDGET > 0
    assert NOTES_WEIGHTS  # non-empty; read_notes_weights already checked the keys


def test_fixed_prompt_overhead_leaves_room_for_the_budget(tokenizer):
    # overhead is the whole prompt with worst-case fields and no notes. the budget
    # must still leave max_new_tokens of room after it
    overhead_short = total_prompt_tokens(tokenizer, TITLE_80, None)

    built = p.build_breakdown_prompt(
        p.BreakdownInput(
            title=TITLE_80,
            subject="AP English Language and Composition",
            description=None,
            due_phrase="in a month",
            session_minutes=180,
        )
    )
    messages = [
        {"role": "system", "content": built.system},
        {"role": "user", "content": built.user},
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    overhead_long = real_tokens_of(tokenizer, text)

    overhead = max(overhead_short, overhead_long)
    ceiling = MAX_SEQ_LEN - MAX_NEW_TOKENS - overhead

    print(
        f"\n[overhead] title80/subject=English/due=in 3 days/session=30 -> {overhead_short} tokens\n"
        f"[overhead] title80/subject=long/due=in a month/session=180 -> {overhead_long} tokens\n"
        f"[overhead] chosen (max) = {overhead} tokens\n"
        f"[ceiling] {MAX_SEQ_LEN} - {MAX_NEW_TOKENS} - {overhead} = {ceiling}\n"
        f"[budget] NOTES_TOKEN_BUDGET = {NOTES_TOKEN_BUDGET} (must be <= ceiling)"
    )

    assert NOTES_TOKEN_BUDGET <= ceiling, (
        f"NOTES_TOKEN_BUDGET={NOTES_TOKEN_BUDGET} exceeds the ceiling {ceiling} "
        f"(= {MAX_SEQ_LEN} - {MAX_NEW_TOKENS} - overhead {overhead}). Lower it "
        "in services/generationPipeline.ts."
    )


@pytest.mark.parametrize("case_name", sorted(SHAPES))
def test_each_shape_clamped_to_the_budget_fits_real_tokens_and_the_full_prompt(
    tokenizer, case_name, capsys
):
    source = SHAPES[case_name]()
    assert estimate_tokens_upper_bound(source) > NOTES_TOKEN_BUDGET, (
        f"[{case_name}] source text was not actually over budget -- "
        "the test proves nothing if clamp_notes has no work to do."
    )

    clamped = clamp_notes(source)
    real_tokens = real_tokens_of(tokenizer, clamped)
    full_prompt_tokens = total_prompt_tokens(tokenizer, TITLE_80, clamped)
    full_total = full_prompt_tokens + MAX_NEW_TOKENS

    with capsys.disabled():
        print(
            f"\n[{case_name}] clamped to {len(clamped)} chars "
            f"(estimate {estimate_tokens_upper_bound(clamped):.1f}) -> "
            f"{real_tokens} real tokens (budget {NOTES_TOKEN_BUDGET}, "
            f"margin {NOTES_TOKEN_BUDGET - real_tokens}); full prompt "
            f"{full_prompt_tokens} tokens, {full_total} with "
            f"max_new_tokens={MAX_NEW_TOKENS} (budget {MAX_SEQ_LEN}, "
            f"margin {MAX_SEQ_LEN - full_total})"
        )

    assert real_tokens <= NOTES_TOKEN_BUDGET, (
        f"[{case_name}] clamped text real-tokenizes to {real_tokens} tokens, "
        f"over NOTES_TOKEN_BUDGET={NOTES_TOKEN_BUDGET}. The estimate "
        "underestimated this shape's real cost -- raise its weight class in "
        "services/generationPipeline.ts (never lower the budget below "
        f"{MIN_NOTES_TOKEN_BUDGET}) and re-measure."
    )
    assert full_total <= MAX_SEQ_LEN, (
        f"[{case_name}] the full prompt built around the clamped text measures "
        f"{full_prompt_tokens} tokens ({full_total} with max_new_tokens), over "
        f"the {MAX_SEQ_LEN}-token max_seq_len."
    )


def test_english_prose_survival_is_reported(tokenizer, capsys):
    # informational, not a gate. printed so the prose-survival trade-off stays visible
    source = shape_english_prose()
    clamped = clamp_notes(source)
    real_tokens = real_tokens_of(tokenizer, clamped)

    with capsys.disabled():
        print(
            f"\n[english_prose survival] {len(clamped)} characters survive the "
            f"clamp at NOTES_TOKEN_BUDGET={NOTES_TOKEN_BUDGET} "
            f"({real_tokens} real tokens). Expected >= 1,500 characters; if "
            "this is below that, it is because the adversarial shapes above "
            "need weights high enough that they also constrain how much "
            "letter-heavy prose the same flat per-character estimate can let "
            "through -- see services/generationPipeline.ts's NOTES_WEIGHTS "
            "comment for the specific trade-off measured here."
        )

    assert len(clamped) > 0


def test_a_shape_far_beyond_the_clamp_is_not_required_to_fit(tokenizer):
    # what would happen without the clamp
    unclamped_tail = shape_dense_no_whitespace()[: NOTES_TOKEN_BUDGET * 6]
    tokens = real_tokens_of(tokenizer, unclamped_tail)
    assert tokens > NOTES_TOKEN_BUDGET


def test_bonus_random_letter_jumble_is_reported_but_not_a_required_shape(tokenizer, capsys):
    # not gated. asciiLetter stays at 0.5 so real prose survives longer, which leaves
    # a run of random letters under-covered
    random.seed(42)
    source = "".join(
        random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(WELL_OVER_BUDGET_CHARS)
    )
    clamped = clamp_notes(source)
    real_tokens = real_tokens_of(tokenizer, clamped)

    with capsys.disabled():
        print(
            f"\n[bonus: random letter jumble, unlisted] clamped to {len(clamped)} chars "
            f"-> {real_tokens} real tokens vs budget {NOTES_TOKEN_BUDGET} "
            f"(margin {NOTES_TOKEN_BUDGET - real_tokens}, negative means over budget). "
            "Not one of the seven required shapes; see the comment above."
        )
