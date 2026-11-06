"""Attach real track and road shapes to transit stop patterns."""
from __future__ import annotations

from collections import defaultdict
import json
import math
from pathlib import Path
from typing import Any

import networkx as nx


LON_SCALE = 0.975  # Longitude degrees are shorter at Chennai's latitude.
METRES_PER_DEGREE = 111_000
SIMPLIFY_TOLERANCE = 0.00004
BUS_CELL = 0.002
BUS_SAMPLE_STOPS = 7
BUS_MEDIAN_LIMIT_M = 160
BUS_STOP_LIMIT_M = 300
BUS_COVERAGE = 0.75
BUS_SAMPLE_SHARE = 0.6
BUS_CANDIDATES = 4
RAIL_SNAP_LIMIT_M = 400
RAIL_DETOUR_LIMIT = 2.5


def squared(a: list[float], b: list[float]) -> float:
    return ((a[0] - b[0]) * LON_SCALE) ** 2 + (a[1] - b[1]) ** 2


def metres(a: list[float], b: list[float]) -> float:
    return math.sqrt(squared(a, b)) * METRES_PER_DEGREE


def simplify(points: list[list[float]], tolerance: float = SIMPLIFY_TOLERANCE) -> list[list[float]]:
    """Remove vertices that do not change a line's shape by more than the tolerance."""
    if len(points) < 3:
        return [[round(x, 5), round(y, 5)] for x, y in points]
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    limit = tolerance ** 2
    while stack:
        first, last = stack.pop()
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        worst, worst_index = 0.0, -1
        for index in range(first + 1, last):
            px, py = points[index]
            if length == 0:
                distance = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
                distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if distance > worst:
                worst, worst_index = distance, index
        if worst > limit:
            keep.add(worst_index)
            stack.append((first, worst_index))
            stack.append((worst_index, last))
    return [[round(points[index][0], 5), round(points[index][1], 5)] for index in sorted(keep)]


def stop_offsets(shape: list[list[float]], stops: list[list[float]]) -> tuple[list[int], list[float]]:
    """Find each stop's nearest vertex, moving only forwards along the shape."""
    offsets: list[int] = []
    gaps: list[float] = []
    position = 0
    for index, stop in enumerate(stops):
        remaining = len(stops) - index - 1
        end = max(position + 1, len(shape) - remaining)
        best, best_distance = position, float("inf")
        for vertex in range(position, min(end, len(shape))):
            distance = squared(shape[vertex], stop)
            if distance < best_distance:
                best, best_distance = vertex, distance
        offsets.append(best)
        gaps.append(math.sqrt(best_distance) * METRES_PER_DEGREE)
        position = best
    return offsets, gaps


def _line_coordinates(feature: dict[str, Any]) -> list[list[float]]:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") == "MultiLineString":
        return [point[:2] for line in coordinates for point in line]
    return [point[:2] for point in coordinates]


class BusShapeMatcher:
    """Match stop patterns to road polylines by the stops they pass."""

    def __init__(self, paths: list[Path]) -> None:
        self.lines: list[list[list[float]]] = []
        self.cells: dict[tuple[int, int], set[int]] = defaultdict(set)
        for path in paths:
            for feature in json.loads(path.read_text(encoding="utf-8"))["features"]:
                line = simplify(_line_coordinates(feature))
                if len(line) < 2:
                    continue
                index = len(self.lines)
                self.lines.append(line)
                for first, second in zip(line, line[1:]):
                    # Index the whole segment; simplified lines have few vertices.
                    steps = max(1, int(math.dist(first, second) / (BUS_CELL / 2)))
                    for step in range(steps + 1):
                        lon = first[0] + (second[0] - first[0]) * step / steps
                        lat = first[1] + (second[1] - first[1]) * step / steps
                        self.cells[(int(lon / BUS_CELL), int(lat / BUS_CELL))].add(index)

    def _candidates(self, stops: list[list[float]]) -> list[int]:
        step = max(1, len(stops) // BUS_SAMPLE_STOPS)
        sample = stops[::step]
        counts: dict[int, int] = defaultdict(int)
        for lon, lat in sample:
            near: set[int] = set()
            column, row = int(lon / BUS_CELL), int(lat / BUS_CELL)
            for delta_column in (-1, 0, 1):
                for delta_row in (-1, 0, 1):
                    near |= self.cells.get((column + delta_column, row + delta_row), set())
            for line in near:
                counts[line] += 1
        required = len(sample) * BUS_SAMPLE_SHARE
        likely = [line for line, count in counts.items() if count >= required]
        return sorted(likely, key=lambda line: -counts[line])[:BUS_CANDIDATES]

    def match(self, stops: list[list[float]]) -> tuple[int, bool, list[int]] | None:
        best: tuple[float, int, bool, list[int]] | None = None
        for line_index in self._candidates(stops):
            line = self.lines[line_index]
            for reverse in (False, True):
                shape = line[::-1] if reverse else line
                offsets, gaps = stop_offsets(shape, stops)
                ordered = sorted(gaps)
                median = ordered[len(ordered) // 2]
                covered = sum(gap <= BUS_STOP_LIMIT_M for gap in gaps) / len(gaps)
                if median <= BUS_MEDIAN_LIMIT_M and covered >= BUS_COVERAGE and (best is None or median < best[0]):
                    best = (median, line_index, reverse, offsets)
        return None if best is None else (best[1], best[2], best[3])


class RailNetwork:
    """Follow the mapped track between consecutive stations."""

    def __init__(self, path: Path) -> None:
        self.graph = nx.Graph()
        ends: list[tuple[float, float]] = []
        for feature in json.loads(path.read_text(encoding="utf-8"))["features"]:
            for line in feature["geometry"]["coordinates"]:
                points = [(round(x, 5), round(y, 5)) for x, y, *_ in line]
                for first, second in zip(points, points[1:]):
                    if first != second:
                        self.graph.add_edge(first, second, weight=metres(list(first), list(second)))
                if points:
                    ends.extend((points[0], points[-1]))
        for index, first in enumerate(ends):
            for second in ends[index + 1:]:
                if first != second and metres(list(first), list(second)) < 40:
                    self.graph.add_edge(first, second, weight=metres(list(first), list(second)))
        self.nodes = list(self.graph.nodes)
        self.cache: dict[tuple[tuple[float, float], tuple[float, float]], list[list[float]] | None] = {}

    def _snap(self, stop: list[float]) -> tuple[float, float] | None:
        node = min(self.nodes, key=lambda candidate: squared(list(candidate), stop))
        return node if metres(list(node), stop) <= RAIL_SNAP_LIMIT_M else None

    def hop(self, first: list[float], second: list[float]) -> list[list[float]] | None:
        key = (tuple(first), tuple(second))
        if key in self.cache:
            return self.cache[key]
        result: list[list[float]] | None = None
        start, goal = self._snap(first), self._snap(second)
        if start and goal and start != goal:
            try:
                path = nx.shortest_path(self.graph, start, goal, weight="weight")
                length = sum(metres(list(a), list(b)) for a, b in zip(path, path[1:]))
                if length <= metres(first, second) * RAIL_DETOUR_LIMIT + 300:
                    result = [list(point) for point in path]
            except nx.NetworkXNoPath:
                result = None
        self.cache[key] = result
        return result

    def pattern_shape(self, stops: list[list[float]]) -> tuple[list[list[float]], list[int]]:
        shape: list[list[float]] = [stops[0]]
        offsets = [0]
        for first, second in zip(stops, stops[1:]):
            shape.extend(self.hop(first, second) or [])
            shape.append(second)
            offsets.append(len(shape) - 1)
        return shape, offsets
