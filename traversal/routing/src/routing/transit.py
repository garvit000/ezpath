"""Timetable search over the merged Chennai metro, suburban rail and bus network."""
from __future__ import annotations

from array import array
from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass
import gzip
import json
from pathlib import Path
from typing import Any, Iterable

from .graph import haversine_m


INFINITY = 10**9
TRANSFER_SLACK_S = 120
MAX_JOURNEY_S = 4 * 3600
GRID_CELL_DEGREES = 0.01


@dataclass(frozen=True)
class Stop:
    name: str
    lat: float
    lon: float
    mode: str
    zone: str
    walkable: bool


class Pattern:
    """Trips sharing one route and stop sequence, stored by stop position."""

    __slots__ = ("route", "stops", "masks", "times", "mode", "shape", "offsets")

    def __init__(self, data: dict[str, Any], mode: str) -> None:
        self.route: int = data["route"]
        self.mode = mode
        self.stops: list[int] = data["stops"]
        self.masks = array("B", data["masks"])
        self.times = [array("I", column) for column in data["times"]]
        self.shape: int | None = data.get("shape")
        self.offsets: list[int] | None = data.get("offsets")

    def first_trip(self, position: int, earliest: int, day_bit: int) -> int | None:
        column = self.times[position]
        trip = bisect_left(column, earliest)
        while trip < len(column):
            if self.masks[trip] & day_bit and column[trip] >= earliest:
                return trip
            trip += 1
        return None


@dataclass(frozen=True)
class Ride:
    pattern: int
    trip: int
    board: int
    alight: int


@dataclass(frozen=True)
class Label:
    arrival: int
    previous_stop: int | None = None
    ride: Ride | None = None
    walk_m: float = 0.0


@dataclass(frozen=True)
class Itinerary:
    arrival: int
    access_stop: int
    egress_stop: int
    steps: tuple[tuple[str, Any], ...]


class TransitNetwork:
    def __init__(self, data: dict[str, Any]) -> None:
        self.sources: list[dict[str, Any]] = data["sources"]
        self.stops = [Stop(*row) for row in data["stops"]]
        self.routes: list[list[str]] = data["routes"]
        self.fares: dict[str, float] = data["fares"]
        self.shapes: list[list[list[float]]] = data.get("shapes", [])
        self.footpaths: list[list[list[float]]] = data["footpaths"]
        self.patterns = [Pattern(item, self.routes[item["route"]][2]) for item in data["patterns"]]
        self.stop_patterns: list[list[tuple[int, int]]] = [[] for _ in self.stops]
        for index, pattern in enumerate(self.patterns):
            for position, stop in enumerate(pattern.stops):
                self.stop_patterns[stop].append((index, position))
        self._grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, stop in enumerate(self.stops):
            if stop.walkable and self.stop_patterns[index]:
                self._grid[self._cell(stop.lat, stop.lon)].append(index)

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        return int(lat / GRID_CELL_DEGREES), int(lon / GRID_CELL_DEGREES)

    @classmethod
    def load(cls, path: str | Path) -> "TransitNetwork":
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return cls(json.load(handle))

    def nearby_stops(self, lat: float, lon: float, radius_m: float, limit: int = 40) -> list[tuple[int, float]]:
        reach = int(radius_m / 1_000) + 1
        row, column = self._cell(lat, lon)
        found: list[tuple[float, int]] = []
        for delta_row in range(-reach, reach + 1):
            for delta_column in range(-reach, reach + 1):
                for index in self._grid.get((row + delta_row, column + delta_column), ()):
                    stop = self.stops[index]
                    distance = haversine_m(lat, lon, stop.lat, stop.lon)
                    if distance <= radius_m:
                        found.append((distance, index))
        found.sort()
        return [(index, distance) for distance, index in found[:limit]]

    def ride_path(self, pattern: Pattern, board: int, alight: int) -> list[list[float]]:
        """Return the mapped track or road between two stop positions."""
        if pattern.shape is not None and pattern.offsets is not None:
            start, end = pattern.offsets[board], pattern.offsets[alight]
            if end > start:
                return self.shapes[pattern.shape][start:end + 1]
        return [[self.stops[stop].lon, self.stops[stop].lat] for stop in pattern.stops[board:alight + 1]]

    def metro_fare(self, board: int, alight: int) -> float | None:
        origin, destination = self.stops[board].zone, self.stops[alight].zone
        return self.fares.get(f"{origin}|{destination}")

    def search(
        self,
        access: dict[int, int],
        egress: dict[int, int],
        departure: int,
        day_bit: int,
        modes: Iterable[str],
        walking_speed_mps: float,
        max_rounds: int = 4,
        blocked_stops: frozenset[int] = frozenset(),
    ) -> list[Itinerary]:
        """Return the earliest arrival for each number of vehicles boarded."""
        allowed = set(modes)
        deadline = departure + MAX_JOURNEY_S
        best = [INFINITY] * len(self.stops)
        rounds: list[dict[int, Label]] = [{}]
        for stop, walk_seconds in access.items():
            arrival = departure + walk_seconds
            rounds[0][stop] = Label(arrival)
            best[stop] = arrival

        target_best = INFINITY
        results: list[Itinerary] = []
        for number in range(1, max_rounds + 1):
            previous = rounds[number - 1]
            current: dict[int, Label] = {}
            queue: dict[int, int] = {}
            for stop in previous:
                for pattern_index, position in self.stop_patterns[stop]:
                    if self.patterns[pattern_index].mode in allowed:
                        queue[pattern_index] = min(position, queue.get(pattern_index, INFINITY))

            for pattern_index, start in queue.items():
                pattern = self.patterns[pattern_index]
                trip: int | None = None
                board = -1
                for position in range(start, len(pattern.stops)):
                    stop = pattern.stops[position]
                    if stop in blocked_stops:
                        continue  # Vehicles may pass a closed stop without serving it.
                    if trip is not None:
                        arrival = pattern.times[position][trip]
                        if arrival < min(best[stop], target_best, deadline):
                            best[stop] = arrival
                            current[stop] = Label(
                                arrival, pattern.stops[board],
                                Ride(pattern_index, trip, board, position),
                            )
                    label = previous.get(stop)
                    if label is None:
                        continue
                    slack = TRANSFER_SLACK_S if number > 1 else 60
                    ready = label.arrival + slack
                    if trip is None or ready <= pattern.times[position][trip]:
                        candidate = pattern.first_trip(position, ready, day_bit)
                        if candidate is not None and (
                            trip is None
                            or pattern.times[position][candidate] < pattern.times[position][trip]
                        ):
                            trip, board = candidate, position

            for stop, label in list(current.items()):
                for other, distance in self.footpaths[stop]:
                    target = int(other)
                    if target in blocked_stops:
                        continue
                    arrival = label.arrival + int(distance * 1.3 / walking_speed_mps)
                    if arrival < min(best[target], target_best, deadline):
                        best[target] = arrival
                        current[target] = Label(arrival, stop, None, distance * 1.3)

            rounds.append(current)
            if not current:
                break
            finish: tuple[int, int] | None = None
            for stop, walk_seconds in egress.items():
                label = current.get(stop)
                if label is None:
                    continue
                total = label.arrival + walk_seconds
                if total < target_best and (finish is None or total < finish[0]):
                    finish = (total, stop)
            if finish is not None:
                target_best = finish[0]
                results.append(self._itinerary(rounds, number, finish[1], finish[0]))
        return results

    def _itinerary(self, rounds: list[dict[int, Label]], number: int, stop: int, arrival: int) -> Itinerary:
        steps: list[tuple[str, Any]] = []
        egress_stop = stop
        while number > 0:
            label = rounds[number][stop]
            if label.ride is None:
                steps.append(("walk", (label.previous_stop, stop, label.walk_m)))
                stop = label.previous_stop  # type: ignore[assignment]
                label = rounds[number][stop]
            ride = label.ride
            assert ride is not None
            steps.append(("ride", ride))
            stop = self.patterns[ride.pattern].stops[ride.board]
            number -= 1
        steps.reverse()
        return Itinerary(arrival, stop, egress_stop, tuple(steps))
