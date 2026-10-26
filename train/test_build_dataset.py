"""Tests for build_dataset.py's guard against pool records that overlap the sealed test split."""

from __future__ import annotations

import build_dataset as bd


def make_sample(
    title: str = "Write a 5-paragraph essay on The Great Gatsby",
    subject: str | None = "English 2H",
    description: str | None = None,
    completion: str | None = None,
) -> bd.Sample:
    if completion is None:
        completion = (
            '{"steps":[{"title":"Open the assignment sheet and read the prompt out loud",'
            '"minutes":5},{"title":"Write the introduction","minutes":20},'
            '{"title":"Write the body paragraphs","minutes":45},'
            '{"title":"Write the conclusion","minutes":15}],'
            '"starterAction":"Open the assignment sheet and read the prompt out loud"}'
        )
    return bd.Sample(
        kind="breakdown",
        task={
            "title": title,
            "subject": subject,
            "description": description,
            "duePhrase": "in 3 days",
            "sessionMinutes": 30,
        },
        completion=completion,
    )


def make_extraction_sample(text: str, completion: str) -> bd.Sample:
    return bd.Sample(kind="extraction", task={"text": text}, completion=completion)


def index_of(*test_samples: bd.Sample) -> list[bd.TestIndexEntry]:
    return bd.build_test_index(list(test_samples))


# 40+ characters so completion-overlap tests clear the short-completion exemption
LONG_COMPLETION_A = (
    '{"steps":[{"title":"Open your lab notebook to the titration data","minutes":5},'
    '{"title":"Copy the raw numbers into the data table","minutes":25},'
    '{"title":"Calculate the concentration for each trial","minutes":30}],'
    '"starterAction":"Open your lab notebook to the titration data"}'
)


def test_exact_prompt_match_is_caught():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    index = index_of(test_sample)
    # different completion, so the prompt match alone has to catch it
    pool_sample = make_sample(
        title="Write a 5-paragraph essay on The Great Gatsby",
        completion=LONG_COMPLETION_A,
    )

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_prompt"
    assert overlap.test_id == 0


def test_prompt_match_is_case_and_whitespace_insensitive():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    index = index_of(test_sample)
    pool_sample = make_sample(title="  WRITE   a 5-Paragraph  ESSAY on the great gatsby  ")

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_prompt"


def test_exact_completion_match_is_caught_even_with_a_different_prompt():
    test_sample = make_sample(
        title="Lab report on titration", subject="Chemistry", completion=LONG_COMPLETION_A
    )
    index = index_of(test_sample)
    pool_sample = make_sample(
        title="A completely unrelated assignment about something else",
        subject="Art History",
        completion=LONG_COMPLETION_A,
    )

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_completion"
    assert overlap.test_id == 0


def test_short_completions_are_exempt_from_the_completion_check():
    # a short completion like a bare starter action legitimately recurs across records
    short = '{"a":1}'
    assert len(short) < 40
    test_sample = make_sample(title="Test prompt number one", completion=short)
    index = index_of(test_sample)
    pool_sample = make_sample(title="A totally different prompt entirely", completion=short)

    assert bd.overlaps_test(pool_sample, index) is None


def test_jaccard_at_0_80_is_caught():
    # 5 of 6 content words shared, plus "today", "monday" and "text"
    base = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
    test_words = list(base)
    pool_words = list(base)
    pool_words[0] = "zulu"
    test_sample = make_extraction_sample(" ".join(test_words), completion=LONG_COMPLETION_A)
    pool_sample = make_extraction_sample(" ".join(pool_words), completion="different")
    index = index_of(test_sample)

    user_text = pool_sample.messages()["messages"][1]["content"]
    test_user_text = test_sample.messages()["messages"][1]["content"]
    import validate as v

    ratio = v.jaccard(set(v.words(user_text)), set(v.words(test_user_text)))
    assert ratio == 0.80

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "jaccard_prompt"


def test_jaccard_at_0_70_is_not_caught():
    base = [f"word{i}" for i in range(14)]
    test_words = list(base)
    pool_words = list(base)
    pool_words[11] = "z11"
    pool_words[12] = "z12"
    pool_words[13] = "z13"
    test_sample = make_extraction_sample(" ".join(test_words), completion=LONG_COMPLETION_A)
    pool_sample = make_extraction_sample(" ".join(pool_words), completion="different")
    index = index_of(test_sample)

    user_text = pool_sample.messages()["messages"][1]["content"]
    test_user_text = test_sample.messages()["messages"][1]["content"]
    import validate as v

    ratio = v.jaccard(set(v.words(user_text)), set(v.words(test_user_text)))
    assert ratio == 0.70

    assert bd.overlaps_test(pool_sample, index) is None


def test_clean_record_returns_none():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    index = index_of(test_sample)
    pool_sample = make_sample(
        title="Lab report on cellular respiration",
        subject="Biology",
        completion=LONG_COMPLETION_A,
    )

    assert bd.overlaps_test(pool_sample, index) is None


def test_json_completion_match_survives_leading_and_trailing_whitespace():
    # stray outer whitespace does not change the object a completion encodes
    padded = f"  \n{LONG_COMPLETION_A}\n  "
    test_sample = make_sample(
        title="Lab report on titration", subject="Chemistry", completion=LONG_COMPLETION_A
    )
    index = index_of(test_sample)
    pool_sample = make_sample(
        title="An unrelated prompt about something else",
        subject="Art History",
        completion=padded,
    )

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_completion"


def test_reports_the_id_of_the_matching_test_record():
    # test_id is the position in test_index, which is the line in test.jsonl
    first = make_sample(title="First test prompt")
    second = make_sample(title="Second test prompt, the one that matters")
    index = index_of(first, second)
    pool_sample = make_sample(title="Second test prompt, the one that matters")

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.test_id == 1


def test_exclude_test_overlap_drops_matching_records_and_keeps_clean_ones():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    index = index_of(test_sample)
    contaminated = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    clean = make_sample(title="Lab report on cellular respiration", completion=LONG_COMPLETION_A)

    kept, by_reason, by_source, contamination = bd.exclude_test_overlap(
        [contaminated, clean], index
    )

    assert kept == [clean]
    assert by_reason["exact_prompt"] == 1
    assert contamination == {0: "exact_prompt"}


def test_reindented_json_completion_is_caught_as_exact_completion():
    # same object, compact vs indent=2. the comparison has to be on the parsed object
    obj = {
        "steps": [
            {"title": "Open the assignment sheet and read the prompt out loud", "minutes": 5},
            {"title": "Write the introduction", "minutes": 20},
            {"title": "Write the body paragraphs", "minutes": 45},
        ],
        "starterAction": "Open the assignment sheet and read the prompt out loud",
    }
    import json

    compact = json.dumps(obj, separators=(",", ":"))
    reindented = json.dumps(obj, indent=2)
    assert compact != reindented  # the fixture must actually differ byte-for-byte

    test_sample = make_sample(title="Lab report on titration", completion=compact)
    index = index_of(test_sample)
    pool_sample = make_sample(
        title="An unrelated prompt about something else entirely", completion=reindented
    )

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_completion"


# extraction prompts share no boilerplate, so disjoint words keep jaccard near zero
# and isolate the completion check from the prompt check
DISJOINT_TEXT_A = "alpha bravo charlie delta echo foxtrot golf hotel india juliet"
DISJOINT_TEXT_B = "zulu yankee xray whiskey victor uniform tango sierra romeo quebec"


def test_reindented_json_completion_with_reordered_keys_is_still_caught():
    obj = {"alpha": 1, "bravo": [1, 2, 3, 4, 5], "charlie": {"x": "yankee", "z": "zulu"}}
    import json

    forward = json.dumps(obj, separators=(",", ":"))
    assert len(forward) >= 40  # must clear the short-completion floor
    reordered_and_spaced = json.dumps(
        {"charlie": {"z": "zulu", "x": "yankee"}, "bravo": [1, 2, 3, 4, 5], "alpha": 1}, indent=4
    )
    assert forward != reordered_and_spaced

    test_sample = make_extraction_sample(DISJOINT_TEXT_A, completion=forward)
    index = index_of(test_sample)
    pool_sample = make_extraction_sample(DISJOINT_TEXT_B, completion=reordered_and_spaced)

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_completion"


def test_non_json_completion_falls_back_to_plain_text_normalisation():
    # a non-json completion falls back to case- and whitespace-insensitive text
    plain = "not json at all, but long enough to clear the short-completion floor"
    padded_and_shouted = f"  {plain.replace(',', ',   ')}  ".upper()
    test_sample = make_extraction_sample(DISJOINT_TEXT_A, completion=plain)
    index = index_of(test_sample)
    pool_sample = make_extraction_sample(DISJOINT_TEXT_B, completion=padded_and_shouted)

    overlap = bd.overlaps_test(pool_sample, index)

    assert overlap is not None
    assert overlap.reason == "exact_completion"


def test_verify_no_test_overlap_in_memory_catches_an_exact_prompt_leak():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    leaked_train_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    clean_val_sample = make_sample(
        title="Lab report on cellular respiration", completion=LONG_COMPLETION_A
    )

    violations = bd.verify_no_test_overlap_in_memory(
        [test_sample], [leaked_train_sample], [clean_val_sample]
    )

    assert len(violations) == 1
    assert "exact_prompt" in violations[0]
    assert "test[0]" in violations[0]
    assert "train[0]" in violations[0]


def test_verify_no_test_overlap_in_memory_is_clean_when_nothing_leaks():
    test_sample = make_sample(title="Write a 5-paragraph essay on The Great Gatsby")
    train_sample = make_sample(
        title="Lab report on cellular respiration", completion=LONG_COMPLETION_A
    )

    violations = bd.verify_no_test_overlap_in_memory([test_sample], [train_sample], [])

    assert violations == []


# dedupe() keys rft-* sources on (prompt, completion) so several sampled completions
# per prompt survive. everything else keys on the prompt

OTHER_COMPLETION = (
    '{"steps":[{"title":"Skim the assignment sheet","minutes":5},'
    '{"title":"Draft an outline","minutes":15},'
    '{"title":"Write the first draft","minutes":30},'
    '{"title":"Revise for clarity","minutes":10}],'
    '"starterAction":"Skim the assignment sheet"}'
)


def test_dedupe_drops_a_second_completion_for_the_same_prompt_from_a_non_rft_source():
    first = make_sample()
    first.source_path = "anchor/batch-01.json"
    second = make_sample(completion=OTHER_COMPLETION)
    second.source_path = "synthesized/electives-01.json"

    out = bd.dedupe([first, second])

    assert out == [first]


def test_dedupe_keeps_several_completions_for_the_same_prompt_from_an_rft_source():
    first = make_sample()
    first.source_path = "synthesized/rft-v4-best-01.json"
    second = make_sample(completion=OTHER_COMPLETION)
    second.source_path = "synthesized/rft-v4-best-01.json"

    out = bd.dedupe([first, second])

    assert out == [first, second]


def test_dedupe_still_drops_an_exact_repeat_from_an_rft_source():
    first = make_sample()
    first.source_path = "synthesized/rft-v4-best-01.json"
    repeat = make_sample()
    repeat.source_path = "synthesized/rft-v4-best-01.json"

    out = bd.dedupe([first, repeat])

    assert out == [first]


def test_dedupe_rft_detection_is_based_on_the_source_filename_not_the_directory():
    first = make_sample()
    first.source_path = "synthesized/electives-02.json"
    second = make_sample(completion=OTHER_COMPLETION)
    second.source_path = "synthesized/electives-02.json"

    out = bd.dedupe([first, second])

    assert out == [first]
