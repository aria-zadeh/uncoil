"""Python-specific validator hazards that parity would only catch if the corpus had that exact shape."""

from __future__ import annotations

import json

import validate as v

TASK = {
    "title": "Write a 5-paragraph essay on The Great Gatsby",
    "subject": "English 2H",
    "description": None,
}

GOOD = {
    "steps": [
        {"title": "Open the assignment sheet and read the prompt out loud", "minutes": 5},
        {"title": "List the three points the essay has to make", "minutes": 10},
        {"title": "Write the introduction without stopping to edit", "minutes": 20},
        {"title": "Write the three body paragraphs", "minutes": 45},
        {"title": "Read it aloud and fix what sounds wrong", "minutes": 15},
    ],
    "starterAction": "Open the assignment sheet and read the prompt out loud",
}


def code(raw, task=TASK):
    return v.validate_breakdown(raw, task).code


def test_accepts_a_well_formed_response():
    assert code(json.dumps(GOOD)) == "ok"


def test_bool_is_not_an_integer_even_though_python_says_it_is():
    # isinstance(True, int) holds in python, so without a bool guard true passes here and fails in the app
    payload = dict(GOOD)
    payload["steps"] = [
        {"title": GOOD["steps"][0]["title"], "minutes": True}
    ] + GOOD["steps"][1:]
    assert code(json.dumps(payload)) == "minutes_not_integer"


def test_python_json_accepts_nan_but_the_schema_must_not():
    # json.loads accepts NaN and Infinity by default, JSON.parse does not
    raw = (
        '{"steps":[{"title":"Open the assignment sheet and read it","minutes":NaN},'
        '{"title":"Write the essay body paragraphs","minutes":30},'
        '{"title":"Read it aloud and fix what sounds wrong","minutes":15}],'
        '"starterAction":"Open the assignment sheet and read it"}'
    )
    assert code(raw) != "ok"


def test_strip_ignores_braces_inside_strings():
    raw = '{"note":"use the {template} file"}'
    assert v.strip_to_json(raw) == raw


def test_strip_stops_at_the_matching_brace():
    assert v.strip_to_json('{"a":1} and then study {more}') == '{"a":1}'


def test_strip_returns_none_for_an_unclosed_object():
    assert v.strip_to_json('{"steps":[{"title":"Open the book"') is None


def test_strip_removes_fences():
    assert v.strip_to_json('```json\n{"a":1}\n```') == '{"a":1}'


def test_words_handles_non_latin_script():
    # str.isalnum() is true for cjk and cyrillic, so these stay content words
    assert v.words("Прочитать главу 4") == ["прочитать", "главу", "4"]
    assert v.words("Hello, world!") == ["hello", "world"]


def test_jaccard_matches_the_typescript_edge_cases():
    assert v.jaccard(set(), set()) == 1.0
    assert v.jaccard({"a"}, set()) == 0.0
    assert v.jaccard({"a", "b"}, {"a", "b"}) == 1.0


def test_vague_phrase_does_not_match_inside_a_longer_word():
    assert v.matches_vague_phrase("Draw the planetary orbit diagram") is None
    assert v.matches_vague_phrase("Plan the essay") == "plan"


def test_sentence_initial_verb_is_not_a_hallucinated_proper_noun():
    assert v.hallucinated_proper_noun("Annotate the prompt with your own words", set()) is None


def test_hallucination_is_caught_mid_title():
    assert v.hallucinated_proper_noun("Read about Daisy Buchanan closely", set()) == "Daisy"


def test_sourced_proper_noun_is_allowed():
    tokens = set(v.words("Write an essay on The Great Gatsby"))
    assert v.hallucinated_proper_noun("Read the Gatsby chapters", tokens) is None


def test_possessive_proper_noun_is_sourced_from_its_stem():
    # words() splits "Ohm's" into "ohm" and "s", so the possessive stem needs its own check
    tokens = set(v.words("Ohm's law problem set"))
    assert v.hallucinated_proper_noun("Open Ohm's law problem set", tokens) is None


def test_unsourced_possessive_proper_noun_still_rejected():
    tokens = set(v.words("Ohm's law problem set"))
    assert v.hallucinated_proper_noun("Read about Newton's third law", tokens) == "Newton's"


def test_curly_apostrophe_possessive_is_sourced_from_its_stem():
    # a curly apostrophe must strip like a straight one, or "Ohm’s" becomes "Ohms"
    tokens = set(v.words("Ohm's law problem set"))
    assert v.hallucinated_proper_noun("Open Ohm’s law problem set", tokens) is None


def test_unsourced_curly_apostrophe_possessive_still_rejected():
    tokens = set(v.words("Write a lab report on cellular respiration"))
    assert v.hallucinated_proper_noun("Read Gatsby’s notes before starting", tokens) == "Gatsby’s"


def test_possessive_stem_requires_a_possessive_shape():
    # regression: "Ohm'sGatsbyNotes" passed on "Ohm's" alone
    tokens = set(v.words("Ohm's law problem set"))
    assert v.hallucinated_proper_noun("Open Ohm'sGatsbyNotes", tokens) == "Ohm'sGatsbyNotes"
    assert v.hallucinated_proper_noun("Open Ohm's law problem set", tokens) is None


def test_title_tokenizer_matches_javascript_whitespace_class():
    # str.split() and js /\s+/ disagree on U+0085 and U+FEFF. the port follows js
    assert v._JS_WHITESPACE_RE.split("ab") == ["ab"]
    assert v._JS_WHITESPACE_RE.split("a﻿b") == ["a", "b"]


def test_hallucinated_proper_noun_splits_on_non_breaking_space():
    tokens = set(v.words("Write a 5-paragraph essay on The Great Gatsby"))
    assert (
        v.hallucinated_proper_noun("Read about Daisy Buchanan now", tokens)
        == "Daisy"
    )


def test_review_and_verify_are_not_imperative_openers():
    # reviewing or verifying is not an observable action apart from reading or checking
    assert not v.starts_with_imperative("Review the notes before the test")
    assert not v.starts_with_imperative("Verify the answer key against the textbook")


def test_widened_verb_whitelist_accepts_new_entries():
    for verb_title, first_word in [
        ("Prove the next ten proofs", "prove"),
        ("Glaze the bowl and let it dry", "glaze"),
    ]:
        assert v.starts_with_imperative(verb_title), first_word


def test_single_word_vague_entry_matches_only_the_first_word():
    for title in [
        "Describe the process of photosynthesis",
        "Draw the floor plan for the set",
        "Solve for x to determine the slope",
        "Copy the twenty words you need to learn",
    ]:
        assert v.matches_vague_phrase(title) is None, title
    assert v.matches_vague_phrase("Think about the essay") == "think about"
    assert v.matches_vague_phrase("Plan the essay") == "plan"


def test_common_capitalized_covers_everyday_assignment_nouns():
    assert v.hallucinated_proper_noun("Open the Google Doc and start typing", set()) is None


def test_common_capitalized_covers_curriculum_named_concepts():
    # regression: "Calvin" (calvin cycle) was rejected as invented in 7 of 10 runs
    assert v.hallucinated_proper_noun("Write the Calvin cycle slide", set()) is None
    assert v.hallucinated_proper_noun("Label where ATP and NADPH are made", set()) is None
    assert v.hallucinated_proper_noun("Solve with the Pythagorean theorem", set()) is None
    assert v.hallucinated_proper_noun("Write down what Mayella says in the courtroom scene", set()) == "Mayella"
    assert v.hallucinated_proper_noun("Read the chapter about Gatsby closely", set()) == "Gatsby"


class TestLexicons:
    """The app compiles the lexicons into a generated module, so a malformed one must fail loudly."""

    def test_every_lexicon_loads_and_is_non_empty(self):
        assert len(v._imperative_verbs()) > 50
        assert len(v._vague_phrases()) > 20
        assert len(v._common_capitalized()) > 20
        assert len(v._stopwords()) > 20

    def test_imperative_verbs_are_lowercase_single_words(self):
        for verb in v._imperative_verbs():
            assert verb == verb.lower(), verb
            assert " " not in verb, verb

    def test_generated_typescript_module_is_in_sync(self):
        # the gate checks this too, but this failure names the file that drifted
        generated = (v.REPO_ROOT / "services" / "lexicon.generated.ts").read_text(
            encoding="utf-8"
        )
        for verb in sorted(v._imperative_verbs())[:20]:
            assert f'"{verb}"' in generated, verb


class TestExtractionAndSimplification:
    def test_extraction_accepts_an_empty_list(self):
        assert v.validate_extraction('{"tasks":[]}').code == "ok"

    def test_extraction_rejects_a_boolean_due_offset(self):
        raw = '{"tasks":[{"title":"Read it","dueInDays":true}]}'
        assert v.validate_extraction(raw).code == "wrong_type"

    def test_extraction_omits_absent_subject_rather_than_emitting_none(self):
        result = v.validate_extraction('{"tasks":[{"title":"Read it","dueInDays":1}]}')
        assert result.ok
        assert "subject" not in result.value["tasks"][0]

    def test_simplification_rejects_a_short_explanation(self):
        raw = '{"title":"Find the tricks","explanation":"Too short"}'
        task = {"title": "x", "description": None}
        assert v.validate_simplification(raw, task).code == "explanation_length"


class TestParityCorpus:
    """The committed corpus must stay large enough and varied enough to matter."""

    def _fixtures(self):
        path = v.REPO_ROOT / "__tests__" / "fixtures" / "validator-parity.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_corpus_meets_the_gate_minimum(self):
        assert len(self._fixtures()) >= 200

    def test_corpus_contains_genuinely_malformed_json(self):
        malformed = 0
        for fixture in self._fixtures():
            try:
                json.loads(fixture["raw"])
            except ValueError:
                malformed += 1
        assert malformed >= 20

    def test_every_fixture_produces_a_verdict_without_raising(self):
        # the validator is total: accept or reject, never raise
        for fixture in self._fixtures():
            result = v.verdict(fixture["kind"], fixture["raw"], fixture.get("task"))
            assert isinstance(result["ok"], bool)
