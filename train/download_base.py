"""Download the base model and confirm it generates. Runs on cpu on purpose."""

from __future__ import annotations

import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
DEVICE = "cpu"


def main() -> int:
    started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=torch.float32)
    model.to(DEVICE)
    model.eval()
    load_seconds = time.time() - started

    params = sum(p.numel() for p in model.parameters())
    print(f"loaded in {load_seconds:.1f}s")
    print(f"parameters: {params:,}")
    print(f"chat template present: {tokenizer.chat_template is not None}")
    print(f"vocab size: {len(tokenizer)}")

    messages = [
        {"role": "system", "content": "Break the assignment into 3 to 7 physical steps. Respond with JSON only."},
        {
            "role": "user",
            "content": (
                "Assignment: Write a 5-paragraph essay on The Great Gatsby\n"
                "Subject: English 2H\nDetails: none\nDue: in 3 days\nSession length: 30"
            ),
        },
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(DEVICE)

    gen_started = time.time()
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=160,
            do_sample=True,
            temperature=0.3,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )
    gen_seconds = time.time() - gen_started
    completion = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    print(f"\ngenerated {out.shape[1] - inputs['input_ids'].shape[1]} tokens in {gen_seconds:.1f}s")
    print("--- raw completion ---")
    print(completion)
    print("--- end ---")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
