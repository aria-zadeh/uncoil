"""Export the fine-tuned model to ExecuTorch. Runs in train/.venv-export, kept apart because executorch pins its own torch."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

TRAIN_DIR = Path(__file__).resolve().parent
REPO_ROOT = TRAIN_DIR.parent
DEFAULT_OUT = TRAIN_DIR / "out" / "export"
ASSETS = REPO_ROOT / "assets" / "model"

ARTIFACT_NAME = "tether-135m-8da4w.pte"
# diagnostic only, for parity.py on runtimes that cannot run the shipping config. never installed
HOST_PARITY_ARTIFACT_NAME = "tether-135m-8da4w-hostparity.pte"
MAX_SEQ_LEN = 1024
FALLBACK_MAX_SEQ_LEN = 768
# the stock prebuilt 8da4w measured 535 MB, so a big artifact means oversized buffers
SIZE_TARGET_BYTES = 200 * 1024 * 1024


def human(n: int) -> str:
    return f"{n:,} bytes ({n / (1024 * 1024):.1f} MB)"


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    print(f"\n$ {' '.join(command)}", flush=True)
    return subprocess.run(
        command, cwd=cwd or REPO_ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


def _collect_eos_token_ids(model_dir: Path) -> list[int]:
    """Every token id that should end generation. The runner refuses a .pte with no get_eos_ids, and the config's eos is only the chat end marker."""
    ids: list[int] = []

    def add(value: object) -> None:
        if isinstance(value, bool):
            return
        if isinstance(value, int):
            if value not in ids:
                ids.append(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                add(item)

    for name in ("generation_config.json", "config.json"):
        path = model_dir / name
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        add(data.get("eos_token_id"))

    vocab: dict[str, int] | None = None
    tokenizer_json = model_dir / "tokenizer.json"
    if tokenizer_json.exists():
        try:
            tok_data = json.loads(tokenizer_json.read_text(encoding="utf-8"))
            vocab = tok_data.get("model", {}).get("vocab")
        except (OSError, json.JSONDecodeError):
            vocab = None

    if vocab:
        add(vocab.get("<|endoftext|>"))
        tok_cfg_path = model_dir / "tokenizer_config.json"
        if tok_cfg_path.exists():
            try:
                tok_cfg = json.loads(tok_cfg_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                tok_cfg = {}
            eos_token = tok_cfg.get("eos_token")
            if isinstance(eos_token, dict):
                eos_token = eos_token.get("content")
            if isinstance(eos_token, str):
                add(vocab.get(eos_token))

    return ids


def _patch_get_eos_ids_constant_method(eos_ids: list[int]) -> None:
    """optimum writes only the singular get_eos_id but the runner reads get_eos_ids, so wrap optimum's metadata builder to add it. Safe to call twice."""
    if not eos_ids:
        return
    import optimum.exporters.executorch.integrations as integrations

    original = integrations.save_config_to_constant_methods

    def patched(config, generation_config=None, processor_config=None, **kwargs):
        metadata = original(config, generation_config=generation_config, processor_config=processor_config, **kwargs)
        metadata.setdefault("get_eos_ids", list(eos_ids))
        return metadata

    integrations.save_config_to_constant_methods = patched


def _eos_ids_bootstrap_code(eos_ids: list[int]) -> str:
    """A `python -c` prelude that applies the same patch inside the optimum-cli subprocess, then runs the real CLI."""
    return (
        "import sys, runpy\n"
        "import optimum.exporters.executorch.integrations as integrations\n"
        f"_eos_ids = {eos_ids!r}\n"
        "_original = integrations.save_config_to_constant_methods\n"
        "def _patched(config, generation_config=None, processor_config=None, **kwargs):\n"
        "    metadata = _original(config, generation_config=generation_config, "
        "processor_config=processor_config, **kwargs)\n"
        "    if _eos_ids:\n"
        "        metadata.setdefault('get_eos_ids', list(_eos_ids))\n"
        "    return metadata\n"
        "integrations.save_config_to_constant_methods = _patched\n"
        "sys.argv = ['optimum-cli'] + sys.argv[1:]\n"
        "runpy.run_module('optimum.commands.optimum_cli', run_name='__main__')\n"
    )


def try_optimum_cli(
    model: Path,
    out_dir: Path,
    max_seq_len: int,
    *,
    host_parity: bool = False,
    qlinear: str | None = "8da4w",
    qembedding: str | None = "4w",
) -> Path | None:
    """`optimum-cli export executorch`. Returns only a .pte that is new or newer, since out_dir may hold unrelated ones."""
    before_mtimes = {p: p.stat().st_mtime for p in out_dir.rglob("*.pte")}
    command = [
        sys.executable,
        "-c",
        _eos_ids_bootstrap_code(_collect_eos_token_ids(model)),
        "export",
        "executorch",
        "--model",
        str(model),
        "--task",
        "text-generation",
        "--recipe",
        "xnnpack",
        "--max_seq_len",
        str(max_seq_len),
        "--output_dir",
        str(out_dir),
    ]
    if qlinear:
        command += ["--qlinear", qlinear]
    if not host_parity:
        # host-parity builds skip this: the windows wheel lacks the custom_sdpa and quantized embedding kernels
        command += ["--use_custom_sdpa"]
        if qembedding:
            command += ["--qembedding", qembedding]
    result = run(command)
    if result.returncode != 0:
        print(result.stdout[-3000:])
        print(result.stderr[-3000:])
        return None

    new_or_updated = sorted(
        p
        for p in out_dir.rglob("*.pte")
        if before_mtimes.get(p) is None or p.stat().st_mtime > before_mtimes[p]
    )
    if not new_or_updated:
        print(
            f"optimum-cli export executorch: no new or updated .pte appeared under "
            f"{out_dir} (only pre-existing artifact(s) found)"
        )
        return None
    return new_or_updated[0]


def _patch_discover_recipes_to_skip_broken_modules() -> None:
    """discover_recipes() imports every recipe, and coreml's needs coremltools, which has no Windows wheel. Both modules are patched since convert binds its own reference."""
    import importlib
    import pkgutil

    from optimum.exporters.executorch import recipe_registry

    def discover_recipes_skip_broken() -> None:
        package = importlib.import_module(recipe_registry.package_name)
        for _, module_name, _ in pkgutil.iter_modules(package.__path__):
            try:
                importlib.import_module(f"{recipe_registry.package_name}.{module_name}")
            except ImportError as exc:
                print(f"skipping recipe module {module_name!r} (not usable on this platform): {exc}")

    recipe_registry.discover_recipes = discover_recipes_skip_broken
    try:
        from optimum.exporters.executorch import convert as _convert_module

        _convert_module.discover_recipes = discover_recipes_skip_broken
    except ImportError:
        pass


def _point_flatc_env_at_bundled_exe() -> None:
    """executorch's flatc lookup misses the binary bundled in executorch.data.bin, so point FLATC_EXECUTABLE at it."""
    import importlib.resources

    try:
        bin_dir = importlib.resources.files("executorch.data.bin")
    except ModuleNotFoundError:
        return
    for name in ("flatc", "flatc.exe"):
        candidate = bin_dir.joinpath(name)
        if candidate.is_file():
            os.environ["FLATC_EXECUTABLE"] = str(candidate)
            return


def try_optimum_python(
    model: Path,
    out_dir: Path,
    max_seq_len: int,
    *,
    host_parity: bool = False,
    qlinear: str | None = "8da4w",
    qembedding: str | None = "4w",
    dtype: str | None = None,
) -> Path | None:
    """The library API, for versions whose CLI flags differ from the above."""
    try:
        from optimum.executorch import ExecuTorchModelForCausalLM  # type: ignore[import-not-found]
    except ImportError as exc:
        print(f"optimum.executorch not importable: {exc}")
        return None

    _patch_discover_recipes_to_skip_broken_modules()
    _point_flatc_env_at_bundled_exe()
    _patch_get_eos_ids_constant_method(_collect_eos_token_ids(model))

    kwargs: dict[str, object] = {
        "max_seq_len": max_seq_len,
        # skips transformers' get_task, which treats any model_id as a hub repo id and rejects a windows path
        "task": "text-generation",
    }
    if qlinear:
        kwargs["qlinear"] = qlinear
    if host_parity:
        # for runtimes missing the custom_sdpa, update_cache and quantized embedding kernels.
        # quantization stays caller-controlled so this path also builds the ladder rungs
        attn_implementation = "sdpa"
        use_custom_kv_cache = False
    else:
        attn_implementation = "custom_sdpa"
        use_custom_kv_cache = True
    if qembedding:
        kwargs["qembedding"] = qembedding
    if dtype:
        # half-precision rung, no integer quantization
        kwargs["dtype"] = dtype

    try:
        model_obj = ExecuTorchModelForCausalLM.from_pretrained(
            str(model),
            recipe="xnnpack",
            attn_implementation=attn_implementation,
            use_custom_kv_cache=use_custom_kv_cache,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 - the point is to report whatever it raises
        print(f"optimum python API failed: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return None

    out_dir.mkdir(parents=True, exist_ok=True)
    before = set(out_dir.rglob("*.pte"))

    # this optimum has no working save_pretrained. the exported .pte sits in the temp dir
    # from_pretrained keeps as _temp_dir
    temp_dir = getattr(model_obj, "_temp_dir", None)
    if temp_dir is not None:
        for pte_file in Path(temp_dir.name).rglob("*.pte"):
            shutil.copy2(pte_file, out_dir / pte_file.name)
    elif hasattr(model_obj, "save_pretrained"):
        # some versions do implement it
        model_obj.save_pretrained(str(out_dir))
    else:
        print("optimum python API: no _temp_dir and no save_pretrained() to recover the .pte from")
        return None

    # out_dir may already hold the shipping artifact, so return a file this call added
    after = set(out_dir.rglob("*.pte"))
    new_files = sorted(after - before)
    return new_files[0] if new_files else next(iter(sorted(after)), None)


def export_once(
    model: Path,
    out_dir: Path,
    max_seq_len: int,
    *,
    host_parity: bool = False,
    qlinear: str | None = "8da4w",
    qembedding: str | None = "4w",
) -> tuple[Path | None, str]:
    # never wipe out_dir, it may hold another run's or another venv's artifacts
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, fn in (
        ("optimum-cli export executorch", try_optimum_cli),
        ("optimum.executorch python API", try_optimum_python),
    ):
        print(
            f"\n=== trying: {name} (max_seq_len={max_seq_len}, host_parity={host_parity}, "
            f"qlinear={qlinear}, qembedding={qembedding}) ===",
            flush=True,
        )
        started = time.time()
        pte = fn(model, out_dir, max_seq_len, host_parity=host_parity, qlinear=qlinear, qembedding=qembedding)
        if pte is not None and pte.exists():
            print(f"{name} produced {pte} in {time.time() - started:.0f}s")
            return pte, name
        print(f"{name} did not produce a .pte")
    return None, ""


def toolchain_versions() -> dict[str, str | None]:
    """Which toolchain produced the artifact. Export venvs pin different executorch releases and the .pte format is version-sensitive."""
    import importlib.metadata

    versions: dict[str, str | None] = {}
    for package in ("executorch", "optimum-executorch", "optimum", "torch", "torchao", "transformers"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def copy_tokenizer(model: Path) -> list[str]:
    """The tokenizer ships alongside the artifact."""
    copied: list[str] = []
    ASSETS.mkdir(parents=True, exist_ok=True)
    for name in ("tokenizer.json", "tokenizer_config.json"):
        source = model / name
        if source.exists():
            shutil.copy2(source, ASSETS / name)
            copied.append(name)
    return copied


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True, help="the merged HF model directory")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--max-seq-len", type=int, default=MAX_SEQ_LEN)
    parser.add_argument(
        "--out-name",
        type=str,
        default=ARTIFACT_NAME,
        help=(
            "filename for the shipping artifact in --out (default: "
            f"{ARTIFACT_NAME}). Use this to run export.py under a different "
            "toolchain venv (e.g. train/.venv-export12, pinned to a different "
            "executorch release - see train/requirements-export12.txt) without "
            "the two runs' artifacts colliding or one deleting the other. "
            "--install refuses anything other than the default name."
        ),
    )
    parser.add_argument(
        "--install",
        action="store_true",
        help="copy the artifact and tokenizer into assets/model/ (parity must pass first)",
    )
    parser.add_argument(
        "--host-parity",
        action="store_true",
        help=(
            f"also export a second, diagnostic-only artifact ({HOST_PARITY_ARTIFACT_NAME}) with "
            "use_custom_sdpa=False, no custom KV-cache op, and unquantized embedding, so "
            "train/parity.py has something this machine's executorch runtime can actually run. "
            "Does not change the shipping export; never installed by --install."
        ),
    )
    args = parser.parse_args()

    # optimum reads a relative path with backslashes as a hub repo id
    args.model = args.model.resolve()

    if not args.model.exists():
        raise SystemExit(f"no model at {args.model}. Run train/train.py first.")

    if args.install and args.out_name != ARTIFACT_NAME:
        raise SystemExit(
            f"--install refuses a non-default --out-name ({args.out_name!r}); "
            f"only {ARTIFACT_NAME!r} (the shipping name) is ever installed into assets/."
        )

    # anything already here belongs to another run or venv and is never deleted
    protected_before = {p.resolve() for p in args.out.glob("*.pte")} if args.out.exists() else set()

    pte, method = export_once(args.model, args.out, args.max_seq_len)

    # over the size target, shrink max_seq_len before changing anything else
    if pte is not None and pte.stat().st_size > SIZE_TARGET_BYTES and args.max_seq_len > FALLBACK_MAX_SEQ_LEN:
        print(
            f"\n{human(pte.stat().st_size)} exceeds the {human(SIZE_TARGET_BYTES)} target. "
            f"Re-exporting at max_seq_len={FALLBACK_MAX_SEQ_LEN}, which is the documented first move."
        )
        smaller, smaller_method = export_once(args.model, args.out, FALLBACK_MAX_SEQ_LEN)
        if smaller is not None:
            pte, method = smaller, smaller_method
            args.max_seq_len = FALLBACK_MAX_SEQ_LEN

    if pte is None:
        print("\nEXPORT FAILED. Every documented entry point was tried and none produced a .pte.")
        print("This is the case HANDOFF.md covers: retry the export on the Mac, where the")
        print("ExecuTorch toolchain is better supported. Record what was tried above.")
        return 1

    size = pte.stat().st_size
    target = args.out / args.out_name
    if pte.resolve() != target.resolve():
        shutil.copy2(pte, target)
        pte.unlink()

    # leave one new .pte. a second makes from_pretrained(directory) warn and guess which to load
    for stray in args.out.glob("*.pte"):
        resolved = stray.resolve()
        if resolved != target.resolve() and resolved not in protected_before:
            stray.unlink()

    host_parity_report: dict | None = None
    if args.host_parity:
        # derived from a non-default --out-name so venvs do not overwrite each other's
        hp_name = HOST_PARITY_ARTIFACT_NAME if args.out_name == ARTIFACT_NAME else f"{Path(args.out_name).stem}-hostparity.pte"
        print(f"\n=== host-parity artifact ({hp_name}) ===")
        # host-parity is the shipping 8da4w linear minus the two missing ops, embedding unquantized
        hp_pte, hp_method = export_once(args.model, args.out, args.max_seq_len, host_parity=True, qembedding=None)
        if hp_pte is None:
            print("\nHOST-PARITY EXPORT FAILED. Every documented entry point was tried and none produced a .pte.")
        else:
            hp_size = hp_pte.stat().st_size
            hp_target = args.out / hp_name
            if hp_pte.resolve() != hp_target.resolve():
                shutil.copy2(hp_pte, hp_target)
                hp_pte.unlink()
            # same sweep, keeping both named targets
            for stray in args.out.glob("*.pte"):
                resolved = stray.resolve()
                if resolved not in (target.resolve(), hp_target.resolve()) and resolved not in protected_before:
                    stray.unlink()
            host_parity_report = {
                "artifact": str(hp_target),
                "bytes": hp_size,
                "megabytes": round(hp_size / (1024 * 1024), 1),
                "max_seq_len": args.max_seq_len,
                "method": hp_method,
                "quantization": "8da4w linear; embedding unquantized (fp)",
                "attention": "sdpa (not custom_sdpa); no custom KV-cache op",
                "backend": "XNNPACK",
                "source_model": str(args.model),
                "toolchain": toolchain_versions(),
                "note": "diagnostic only, not for shipping - never installed by --install",
            }
            hp_report_name = (
                "export-report-hostparity.json"
                if args.out_name == ARTIFACT_NAME
                else f"export-report-{Path(hp_name).stem}.json"
            )
            (args.out / hp_report_name).write_text(json.dumps(host_parity_report, indent=2) + "\n", encoding="utf-8")
            print(f"\nhost-parity artifact  {hp_target}")
            print(f"size                  {human(hp_size)}")
            print(f"method                {hp_method}")

    report = {
        "artifact": str(target),
        "bytes": size,
        "megabytes": round(size / (1024 * 1024), 1),
        "under_200mb": size <= SIZE_TARGET_BYTES,
        "max_seq_len": args.max_seq_len,
        "method": method,
        "quantization": "8da4w, embedding 4-bit",
        "backend": "XNNPACK",
        "source_model": str(args.model),
        "toolchain": toolchain_versions(),
    }
    report_name = "export-report.json" if args.out_name == ARTIFACT_NAME else f"export-report-{Path(args.out_name).stem}.json"
    (args.out / report_name).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    # the recipe beside the .pte for parity.py --reference matched, which never guesses one.
    # dtype is None because this path never sets one
    metadata_name = (
        "export-metadata.json" if args.out_name == ARTIFACT_NAME else f"export-metadata-{Path(args.out_name).stem}.json"
    )
    export_metadata = {
        "qlinear": "8da4w",
        "qembedding": "4w",
        "dtype": None,
        "max_seq_len": args.max_seq_len,
        "model": str(args.model),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (args.out / metadata_name).write_text(json.dumps(export_metadata, indent=2) + "\n", encoding="utf-8")

    print(f"\nartifact  {target}")
    print(f"size      {human(size)}  target {human(SIZE_TARGET_BYTES)}")
    print(f"method    {method}")
    print(f"under target: {report['under_200mb']}")

    if args.install:
        # a separate step, run only after parity.py passes. the host-parity artifact never ships
        shutil.copy2(target, ASSETS / ARTIFACT_NAME)
        copied = copy_tokenizer(args.model)
        print(f"\ninstalled into {ASSETS}: {ARTIFACT_NAME}, {', '.join(copied) or 'no tokenizer files found'}")
        print("Track the .pte with Git LFS before committing.")
        if host_parity_report is not None:
            print(f"({HOST_PARITY_ARTIFACT_NAME} was NOT installed - diagnostic only.)")
    else:
        print("\nNot installed. Run train/parity.py first, then re-run with --install.")

    return 0 if report["under_200mb"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
