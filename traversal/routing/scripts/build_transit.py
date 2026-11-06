"""Build the Chennai transit artifact and the planner's location catalog."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from routing.artifacts import sha256_file
from routing.transit_build import FeedSource, build_artifact, build_location_catalog, write_artifact


ROUTING_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = ROUTING_ROOT.parents[1] / "data"
DEFAULT_OUTPUT = ROUTING_ROOT / "data" / "chennai-transit.json.gz"
DEFAULT_CATALOG = ROUTING_ROOT / "config" / "chennai-locations.json"

BUS_DATA = DATA_ROOT / "static_mtc_gtfs_data" / "static_mtc_gtfs_data"
RAIL_DATA = DATA_ROOT / "Southern Railways" / "Southern Railways"

SOURCES = (
    # The published metro calendar ended in 2021, so it is used as a typical schedule.
    FeedSource("metro", "Chennai Metro Rail (CMRL)", "metro", DATA_ROOT / "CMRL gtfs" / "CMRL gtfs",
               ignore_calendar=True),
    FeedSource("rail", "Southern Railway suburban", "rail", RAIL_DATA / "chennai.suburban.gtfs.zip",
               shape_paths=(RAIL_DATA / "srr_corridor.geojson",)),
    FeedSource("bus", "Chennai MTC bus (CUMTA)", "bus", BUS_DATA / "chennai.bus.gtfs.zip",
               shape_paths=(BUS_DATA / "routes_polyline.geojson", BUS_DATA / "all_mtc_routes.geojson")),
)
TERMINI = BUS_DATA / "bus_terminus.geojson"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    args = parser.parse_args()

    artifact = build_artifact(SOURCES)
    write_artifact(artifact, args.output)
    catalog = build_location_catalog(artifact, TERMINI)
    args.catalog.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")

    trips = sum(len(pattern["masks"]) for pattern in artifact["patterns"])
    print(f"Stops: {len(artifact['stops'])}")
    print(f"Patterns: {len(artifact['patterns'])}")
    print(f"Trips: {trips}")
    print(f"Metro fare pairs: {len(artifact['fares'])}")
    print(f"Shapes: {len(artifact['shapes'])}; patterns with real paths: {artifact['shape_coverage']}")
    print(f"Stops excluded from walking: {len(artifact['unreliable_stops'])}")
    print(f"Catalog locations: {len(catalog['locations'])}")
    print(f"Artifact: {args.output} ({args.output.stat().st_size} bytes)")
    print(f"SHA-256: {sha256_file(args.output)}")


if __name__ == "__main__":
    main()
