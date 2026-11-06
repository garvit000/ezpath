"""Build the lightweight ZIP asset consumed by the CDK routing stack."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / ".build" / "route_lambda"


def build(output: Path) -> Path:
    destination = output.resolve()
    build_root = (ROOT / ".build").resolve()
    if build_root not in destination.parents:
        raise ValueError(f"package output must be inside {build_root}")

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)

    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-compile",
            "--target",
            str(destination),
            "--requirement",
            str(ROOT / "backend" / "route_lambda" / "requirements.txt"),
        ],
        check=True,
    )

    adapter = ROOT / "backend" / "route_lambda"
    shutil.copy2(adapter / "handler.py", destination / "handler.py")
    shutil.copy2(adapter / "graph_artifact.py", destination / "graph_artifact.py")
    shutil.copy2(adapter / "status_overlay.py", destination / "status_overlay.py")
    shutil.copytree(
        ROOT / "traversal" / "routing" / "src" / "routing",
        destination / "routing",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )
    catalog = destination / "routing" / "catalog"
    catalog.mkdir()
    for name in ("campus-locations.json", "chennai-locations.json"):
        shutil.copy2(ROOT / "traversal" / "routing" / "config" / name, catalog / name)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    package = build(args.output)
    print(f"Built routing Lambda package: {package}")


if __name__ == "__main__":
    main()
