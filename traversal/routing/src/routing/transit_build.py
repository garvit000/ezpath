"""Merge the Chennai GTFS feeds into one compact routing artifact."""
from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
import gzip
import io
import json
import math
from pathlib import Path
import re
from typing import Any, Iterable
import zipfile

from .graph import haversine_m
from .shapes import BusShapeMatcher, RailNetwork, simplify, stop_offsets


ARTIFACT_VERSION = 1
ALL_DAYS = 0b1111111
WEEKDAY_COLUMNS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
FOOTPATH_RADIUS_M = 400.0
MAX_FOOTPATHS_PER_STOP = 10
MAX_PLAUSIBLE_SPEED_MPS = 35.0
IMPLAUSIBLE_HOP_SHARE = 0.4
MIDNIGHT_WRAP_S = 6 * 3600


class Feed:
    """Read GTFS tables from a folder or a zip with an optional nested folder."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._zip: zipfile.ZipFile | None = None
        self._prefix = ""
        if self.path.is_file():
            self._zip = zipfile.ZipFile(self.path)
            stops = next(name for name in self._zip.namelist() if name.endswith("stops.txt"))
            self._prefix = stops[: -len("stops.txt")]

    def rows(self, table: str) -> Iterable[dict[str, str]]:
        if self._zip is None:
            file_path = self.path / table
            if not file_path.is_file():
                return
            with file_path.open(encoding="utf-8-sig", newline="") as handle:
                yield from csv.DictReader(handle)
            return
        name = self._prefix + table
        if name not in self._zip.namelist():
            return
        with self._zip.open(name) as handle:
            yield from csv.DictReader(io.TextIOWrapper(handle, "utf-8-sig", newline=""))


@dataclass(frozen=True)
class FeedSource:
    id: str
    name: str
    mode: str
    path: Path
    ignore_calendar: bool = False
    # Road or track geometry used when a feed has no shapes of its own.
    shape_paths: tuple[Path, ...] = ()


def seconds(value: str) -> int:
    hours, minutes, secs = value.strip().split(":")
    return int(hours) * 3600 + int(minutes) * 60 + int(secs)


def service_masks(feed: Feed) -> dict[str, int]:
    masks: dict[str, int] = {}
    for row in feed.rows("calendar.txt"):
        mask = 0
        for bit, column in enumerate(WEEKDAY_COLUMNS):
            if row.get(column, "0").strip() == "1":
                mask |= 1 << bit
        masks[row["service_id"]] = mask
    return masks


def calendar_end(feed: Feed) -> str | None:
    ends = [row["end_date"].strip() for row in feed.rows("calendar.txt") if row.get("end_date")]
    return max(ends) if ends else None


def display_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", raw).strip().title()
    return re.sub(r"\b(Jn|Rs|Bt|Mrts|Srm|Mgr|Cmbt)\b", lambda match: match.group(0).upper(), name)


class ArtifactBuilder:
    def __init__(self) -> None:
        self.stops: list[dict[str, Any]] = []
        self.stop_index: dict[str, int] = {}
        self.routes: list[list[str]] = []
        self.pattern_trips: dict[tuple[int, tuple[int, ...]], list[tuple[int, list[int]]]] = defaultdict(list)
        self.fares: dict[str, float] = {}
        self.sources: list[dict[str, Any]] = []
        self.feed_shapes: dict[str, list[list[float]]] = {}
        self.pattern_shape_ids: dict[tuple[int, tuple[int, ...]], str] = {}
        self.bus_shape_paths: list[Path] = []
        self.rail_shape_path: Path | None = None

    def add_stop(self, key: str, name: str, lat: float, lon: float, mode: str, zone: str = "") -> int:
        index = self.stop_index.get(key)
        if index is None:
            index = len(self.stops)
            self.stop_index[key] = index
            self.stops.append({"key": key, "name": display_name(name), "lat": lat, "lon": lon,
                               "mode": mode, "zone": zone, "walkable": True})
        return index

    def add_feed(self, source: FeedSource) -> None:
        feed = Feed(source.path)
        rows = {row["stop_id"]: row for row in feed.rows("stops.txt")}
        stop_lookup: dict[str, int] = {}

        def resolve(stop_id: str) -> int | None:
            cached = stop_lookup.get(stop_id)
            if cached is not None:
                return cached
            row = rows.get(stop_id)
            if row is None:
                return None
            parent = rows.get((row.get("parent_station") or "").strip())
            station = parent or row
            key = f"{source.id}:{station['stop_id']}"
            index = self.add_stop(
                key, station["stop_name"], float(station["stop_lat"]), float(station["stop_lon"]),
                source.mode, (station.get("zone_id") or "").strip(),
            )
            stop_lookup[stop_id] = index
            return index

        routes: dict[str, int] = {}
        for row in feed.rows("routes.txt"):
            routes[row["route_id"]] = len(self.routes)
            self.routes.append([
                (row.get("route_short_name") or "").strip(),
                display_name(row.get("route_long_name") or ""),
                source.mode,
            ])

        masks = service_masks(feed)
        trips: dict[str, tuple[int, int]] = {}
        trip_shapes: dict[str, str] = {}
        for row in feed.rows("trips.txt"):
            mask = ALL_DAYS if source.ignore_calendar else masks.get(row["service_id"], 0)
            if mask and row["route_id"] in routes:
                trips[row["trip_id"]] = (routes[row["route_id"]], mask)
                if (row.get("shape_id") or "").strip():
                    trip_shapes[row["trip_id"]] = f"{source.id}:{row['shape_id'].strip()}"

        points: dict[str, list[tuple[int, list[float]]]] = defaultdict(list)
        for row in feed.rows("shapes.txt"):
            points[f"{source.id}:{row['shape_id']}"].append((
                int(row["shape_pt_sequence"]),
                [float(row["shape_pt_lon"]), float(row["shape_pt_lat"])],
            ))
        for shape_id, vertices in points.items():
            self.feed_shapes[shape_id] = simplify([vertex for _, vertex in sorted(vertices, key=lambda item: item[0])])
        if source.mode == "bus":
            self.bus_shape_paths.extend(source.shape_paths)
        if source.mode == "rail" and source.shape_paths:
            self.rail_shape_path = source.shape_paths[0]

        current_trip: str | None = None
        events: list[tuple[int, int, int]] = []

        def flush() -> None:
            if current_trip is None or len(events) < 2:
                return
            route, mask = trips[current_trip]
            ordered = sorted(events)
            stops: list[int] = []
            times: list[int] = []
            day_offset = 0
            for _, stop, departure in ordered:
                if stops and stops[-1] == stop:
                    continue
                departure += day_offset
                if times and departure < times[-1]:
                    # Some feeds write after-midnight times as 00:10 instead of 24:10.
                    if times[-1] - departure > MIDNIGHT_WRAP_S:
                        day_offset += 86_400
                        departure += 86_400
                    else:
                        departure = times[-1]
                stops.append(stop)
                times.append(departure)
            if len(stops) >= 2:
                key = (route, tuple(stops))
                self.pattern_trips[key].append((mask, times))
                if current_trip in trip_shapes:
                    self.pattern_shape_ids[key] = trip_shapes[current_trip]

        by_trip: dict[str, list[tuple[int, int, int]]] = defaultdict(list)
        for row in feed.rows("stop_times.txt"):
            if row["trip_id"] not in trips:
                continue
            stop = resolve(row["stop_id"])
            departure = (row.get("departure_time") or row.get("arrival_time") or "").strip()
            if stop is not None and departure:
                by_trip[row["trip_id"]].append((int(row["stop_sequence"]), stop, seconds(departure)))
        for current_trip, events in by_trip.items():
            flush()

        fare_prices = {row["fare_id"]: float(row["price"]) for row in feed.rows("fare_attributes.txt")}
        for row in feed.rows("fare_rules.txt"):
            price = fare_prices.get(row["fare_id"])
            if price is not None:
                self.fares[f"{row['origin_id'].strip()}|{row['destination_id'].strip()}"] = price

        end = calendar_end(feed)
        self.sources.append({
            "id": source.id,
            "name": source.name,
            "mode": source.mode,
            "calendar_end": end,
            "typical_schedule": source.ignore_calendar,
            "has_fares": bool(fare_prices),
        })

    def mark_unreliable_stops(self) -> list[str]:
        """Exclude stops whose coordinates imply impossible vehicle speeds from walking."""
        hops: dict[int, int] = defaultdict(int)
        implausible: dict[int, int] = defaultdict(int)
        for (_, stops), trips in self.pattern_trips.items():
            _, times = trips[0]
            for position in range(len(stops) - 1):
                first, second = self.stops[stops[position]], self.stops[stops[position + 1]]
                distance = haversine_m(first["lat"], first["lon"], second["lat"], second["lon"])
                elapsed = max(1, times[position + 1] - times[position])
                hops[stops[position]] += 1
                hops[stops[position + 1]] += 1
                if distance / elapsed > MAX_PLAUSIBLE_SPEED_MPS:
                    implausible[stops[position]] += 1
                    implausible[stops[position + 1]] += 1
        flagged = [stop for stop, count in implausible.items() if count / hops[stop] > IMPLAUSIBLE_HOP_SHARE]
        for stop in flagged:
            self.stops[stop]["walkable"] = False
        return sorted(self.stops[stop]["name"] for stop in flagged)

    def footpaths(self) -> list[list[list[float]]]:
        cell_size = 0.005
        cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, stop in enumerate(self.stops):
            if stop["walkable"]:
                cells[(int(stop["lat"] / cell_size), int(stop["lon"] / cell_size))].append(index)
        reach = math.ceil(FOOTPATH_RADIUS_M / 111_000 / cell_size) + 1
        result: list[list[list[float]]] = [[] for _ in self.stops]
        for index, stop in enumerate(self.stops):
            if not stop["walkable"]:
                continue
            row, column = int(stop["lat"] / cell_size), int(stop["lon"] / cell_size)
            nearby: list[tuple[float, int]] = []
            for delta_row in range(-reach, reach + 1):
                for delta_column in range(-reach, reach + 1):
                    for other in cells.get((row + delta_row, column + delta_column), ()):
                        if other == index:
                            continue
                        candidate = self.stops[other]
                        distance = haversine_m(stop["lat"], stop["lon"], candidate["lat"], candidate["lon"])
                        if distance <= FOOTPATH_RADIUS_M:
                            nearby.append((distance, other))
            nearby.sort()
            result[index] = [[other, round(distance, 1)] for distance, other in nearby[:MAX_FOOTPATHS_PER_STOP]]
        return result

    def _assign_shapes(self) -> tuple[list[list[list[float]]], dict[tuple[int, tuple[int, ...]], tuple[int, list[int]]], dict[str, int]]:
        shapes: list[list[list[float]]] = []
        known: dict[str, int] = {}
        assigned: dict[tuple[int, tuple[int, ...]], tuple[int, list[int]]] = {}
        counts = {"metro": 0, "rail": 0, "bus": 0}
        matcher = BusShapeMatcher(self.bus_shape_paths) if self.bus_shape_paths else None
        rail = RailNetwork(self.rail_shape_path) if self.rail_shape_path else None

        def remember(key: str, shape: list[list[float]]) -> int:
            if key not in known:
                known[key] = len(shapes)
                shapes.append(shape)
            return known[key]

        for pattern_key in self.pattern_trips:
            route, stops = pattern_key
            mode = self.routes[route][2]
            points = [[round(self.stops[stop]["lon"], 5), round(self.stops[stop]["lat"], 5)] for stop in stops]
            shape_id = self.pattern_shape_ids.get(pattern_key)
            if shape_id in self.feed_shapes:
                offsets, _ = stop_offsets(self.feed_shapes[shape_id], points)
                assigned[pattern_key] = (remember(shape_id, self.feed_shapes[shape_id]), offsets)
                counts[mode] += 1
            elif mode == "rail" and rail is not None:
                shape, offsets = rail.pattern_shape(points)
                assigned[pattern_key] = (remember(f"rail:{stops}", shape), offsets)
                counts[mode] += 1
            elif mode == "bus" and matcher is not None:
                match = matcher.match(points)
                if match is not None:
                    line, reverse, offsets = match
                    shape = matcher.lines[line][::-1] if reverse else matcher.lines[line]
                    assigned[pattern_key] = (remember(f"bus:{line}:{reverse}", shape), offsets)
                    counts[mode] += 1
        return shapes, assigned, counts

    def artifact(self) -> dict[str, Any]:
        flagged = self.mark_unreliable_stops()
        shapes, assigned, shape_counts = self._assign_shapes()
        patterns = []
        for key, trips in self.pattern_trips.items():
            route, stops = key
            trips.sort(key=lambda trip: trip[1][0])
            shape, offsets = assigned.get(key, (None, None))
            patterns.append({
                "route": route,
                "stops": list(stops),
                "masks": [mask for mask, _ in trips],
                "times": [[times[position] for _, times in trips] for position in range(len(stops))],
                "shape": shape,
                "offsets": offsets,
            })
        return {
            "schema_version": ARTIFACT_VERSION,
            "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "timezone": "Asia/Kolkata",
            "sources": self.sources,
            "stops": [[stop["name"], stop["lat"], stop["lon"], stop["mode"], stop["zone"], stop["walkable"]]
                      for stop in self.stops],
            "routes": self.routes,
            "patterns": patterns,
            "shapes": shapes,
            "shape_coverage": shape_counts,
            "footpaths": self.footpaths(),
            "fares": self.fares,
            "unreliable_stops": flagged,
        }


def build_artifact(sources: Iterable[FeedSource]) -> dict[str, Any]:
    builder = ArtifactBuilder()
    for source in sources:
        builder.add_feed(source)
    return builder.artifact()


def write_artifact(artifact: dict[str, Any], path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(artifact, handle, separators=(",", ":"))


def build_location_catalog(artifact: dict[str, Any], termini_path: str | Path) -> dict[str, Any]:
    """List stations and bus termini travellers can select in the planner."""
    locations: list[dict[str, Any]] = []
    served = {stop for pattern in artifact["patterns"] for stop in pattern["stops"]}
    for index, (name, lat, lon, mode, _, walkable) in enumerate(artifact["stops"]):
        if mode == "bus" or index not in served or not walkable:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        locations.append({
            "id": f"{mode}-{slug}",
            "name": name,
            "category": "metro_station" if mode == "metro" else "suburban_station",
            "latitude": round(lat, 7),
            "longitude": round(lon, 7),
        })
    termini = json.loads(Path(termini_path).read_text(encoding="utf-8"))
    for feature in termini["features"]:
        name = next((str(value) for key, value in feature["properties"].items()
                     if key.startswith("Name") and value), "")
        coordinates = feature.get("geometry", {}).get("coordinates")
        if not name or not coordinates:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        locations.append({
            "id": f"bus-{slug}",
            "name": display_name(name),
            "category": "bus_terminus",
            "latitude": round(float(coordinates[1]), 7),
            "longitude": round(float(coordinates[0]), 7),
        })
    unique = {location["id"]: location for location in locations}
    ordered = sorted(unique.values(), key=lambda location: (location["category"], location["name"]))
    return {
        "schema_version": 1,
        "region": "chennai",
        "generated_from": date.today().isoformat(),
        "attribution": "CMRL, Southern Railway and CUMTA GTFS feeds",
        "locations": ordered,
    }
