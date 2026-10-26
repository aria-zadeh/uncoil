"""The device is always passed explicitly, never picked by availability, and defaults to cpu."""

import argparse
import sys

import pytest

import train


def test_device_defaults_to_cpu():
    args = train.build_parser().parse_args(["--run-name", "x"])
    assert args.device == "cpu"


def test_device_accepts_mps():
    args = train.build_parser().parse_args(["--device", "mps"])
    assert args.device == "mps"


def test_device_accepts_cuda():
    args = train.build_parser().parse_args(["--device", "cuda"])
    assert args.device == "cuda"


def test_device_rejects_bad_choice():
    with pytest.raises(SystemExit):
        train.build_parser().parse_args(["--device", "tpu"])


def test_device_mps_without_mps_refuses_before_model_load(monkeypatch):
    monkeypatch.setattr(train.torch.backends.mps, "is_available", lambda: False)
    monkeypatch.setattr(sys, "argv", ["train.py", "--device", "mps", "--run-name", "t"])
    assert train.main() == 1


def test_device_cuda_without_cuda_refuses(monkeypatch):
    monkeypatch.setattr(train.torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(sys, "argv", ["train.py", "--device", "cuda", "--run-name", "t"])
    assert train.main() == 1


def test_bf16_with_mps_refuses(monkeypatch):
    monkeypatch.setattr(
        sys, "argv", ["train.py", "--device", "mps", "--dtype", "bf16", "--run-name", "t"]
    )
    assert train.main() == 1


class _FakeResult:
    global_step = 225
    training_loss = 0.9731


def test_runs_md_entry_includes_device_line():
    args = argparse.Namespace(
        run_name="v8",
        base=train.BASE_MODEL,
        dtype="fp32",
        device="mps",
        epochs=3,
        batch=16,
        grad_accum=2,
        lr=2e-5,
        seed=42,
        data_dir=train.DATA_DIR,
    )
    history = train.LossHistory()
    history.eval = [(25, 1.1), (50, 0.9)]
    entry = train.build_entry(
        args,
        _FakeResult(),
        eval_loss=0.9,
        wall_seconds=120.0,
        train_ds=[0] * 10,
        eval_ds=[0] * 5,
        history=history,
        output_dir=train.OUT_DIR / "v8",
        train_path=train.DATA_DIR / "train.jsonl",
        val_path=train.DATA_DIR / "val.jsonl",
    )
    assert "device `mps`" in entry
