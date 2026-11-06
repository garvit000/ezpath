"""Materialise the versioned routing graph used by the Lambda runtime."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def ensure_graph_artifact(
    local_path: str,
    *,
    bucket: str | None,
    key: str | None,
    s3_client: Any | None = None,
) -> str:
    """Return a local graph path, downloading it from S3 when necessary."""
    destination = Path(local_path)
    if destination.is_file():
        return str(destination)
    if not bucket or not key:
        raise RuntimeError(
            "ROUTING_GRAPH_UNAVAILABLE: set EZPATH_GRAPH_BUCKET and "
            "EZPATH_GRAPH_KEY, or provide EZPATH_GRAPH_PATH"
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    if s3_client is None:
        import boto3

        s3_client = boto3.client("s3")
    s3_client.download_file(bucket, key, str(destination))

    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("ROUTING_GRAPH_DOWNLOAD_FAILED: downloaded artifact is missing or empty")
    return str(destination)


def transit_settings_from_environment() -> tuple[str, str | None, str | None]:
    return (
        os.environ.get("EZPATH_TRANSIT_PATH", "/tmp/ezpath/chennai-transit.json.gz"),
        os.environ.get("EZPATH_GRAPH_BUCKET"),
        os.environ.get("EZPATH_TRANSIT_KEY"),
    )


def graph_settings_from_environment() -> tuple[str, str | None, str | None]:
    return (
        os.environ.get("EZPATH_GRAPH_PATH", "/tmp/ezpath/campus.graphml"),
        os.environ.get("EZPATH_GRAPH_BUCKET"),
        os.environ.get("EZPATH_GRAPH_KEY"),
    )
