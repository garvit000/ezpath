"""Build the dependency-free report Lambda staging directory."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / ".build" / "report_lambda"


def build(output: Path = DEFAULT_OUTPUT) -> Path:
    output = output.resolve()
    build_root = (ROOT / ".build").resolve()
    if output.parent != build_root:
        raise ValueError(f"output must be a direct child of {build_root}")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for name in ("handler.py", "repository.py"):
        shutil.copy2(SOURCE / name, output / name)
    for name in ("campus-locations.json", "chennai-locations.json"):
        shutil.copy2(ROOT / "traversal" / "routing" / "config" / name, output / name)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    print(f"Built report Lambda package: {build(parser.parse_args().output)}")
