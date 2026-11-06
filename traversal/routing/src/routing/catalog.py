"""Named places shared by the planner, disruptions and traveller reports."""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any, Iterable

import networkx as nx

from .graph import haversine_m


CATALOG_FILES = ("campus-locations.json", "chennai-locations.json")
BLOCK_RADIUS_M = 150.0


def _catalog_folder() -> Path:
    packaged = Path(__file__).resolve().parent / "catalog"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[2] / "config"


@lru_cache(maxsize=1)
def locations() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name in CATALOG_FILES:
        data = json.loads((_catalog_folder() / name).read_text(encoding="utf-8"))
        result.update({location["id"].casefold(): location for location in data["locations"]})
    return result


def blocked_locations(blocked_ids: Iterable[str]) -> list[dict[str, Any]]:
    known = locations()
    return [known[identity] for identity in blocked_ids if identity in known]


def expand_blocked(blocked_ids: Iterable[str], graph: nx.MultiDiGraph | None) -> frozenset[str]:
    """Add walking graph nodes close to any disrupted named place."""
    expanded = {str(identity).strip().casefold() for identity in blocked_ids}
    places = blocked_locations(expanded)
    if graph is None or not places:
        return frozenset(expanded)
    for node, data in graph.nodes(data=True):
        lat, lon = float(data["y"]), float(data["x"])
        if any(haversine_m(lat, lon, place["latitude"], place["longitude"]) <= BLOCK_RADIUS_M for place in places):
            expanded.add(f"node:{node}")
    return frozenset(expanded)
