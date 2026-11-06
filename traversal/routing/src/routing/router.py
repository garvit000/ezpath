"""Bounded multi-label A* routing with hard constraints and Pareto alternatives."""
from __future__ import annotations
from dataclasses import dataclass
from itertools import count
import hashlib
import heapq
import json
import math
from typing import Any
import networkx as nx
from .accessibility import evaluate_edge, get_tag
from .graph import haversine_m
from .status import edge_is_blocked, node_is_blocked, normalize_blocked_entities


@dataclass
class Label:
    node: Any
    time_min: float
    walk_m: float
    uncertainty: float
    unknown_edge_count: int
    path: tuple[tuple[Any, Any, Any], ...]
    active: bool = True


def _edge_length(data: dict) -> float:
    raw = data.get("length")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError("EDGE_LENGTH_MISSING: an edge has no valid length in metres")
    if not math.isfinite(value) or value < 0:
        raise ValueError("EDGE_LENGTH_INVALID: edge length must be finite and non-negative")
    return value


def _edge_minutes(data: dict, speed_mps: float) -> float:
    raw = data.get("travel_time")
    if raw is not None:
        try:
            seconds = float(raw)
            if math.isfinite(seconds) and seconds >= 0:
                return seconds / 60.0
        except (TypeError, ValueError):
            pass
    return _edge_length(data) / speed_mps / 60.0


def _edge_points(geometry: Any) -> list[list[float]]:
    """Read edge geometry from a shapely line or the WKT text stored in GraphML."""
    if geometry is None:
        return []
    if hasattr(geometry, "coords"):
        return [[float(x), float(y)] for x, y in geometry.coords]
    text = str(geometry).strip()
    if not text.upper().startswith("LINESTRING") or "(" not in text:
        return []
    points = []
    for pair in text[text.index("(") + 1:text.rindex(")")].split(","):
        values = pair.split()
        if len(values) >= 2:
            points.append([float(values[0]), float(values[1])])
    return points


def _dominates(a: Label, b: Label, eps: float = 1e-9) -> bool:
    no_worse = (a.time_min <= b.time_min + eps and a.walk_m <= b.walk_m + eps
                and a.uncertainty <= b.uncertainty + eps)
    strictly_better = (a.time_min < b.time_min - eps or a.walk_m < b.walk_m - eps
                       or a.uncertainty < b.uncertainty - eps)
    return no_worse and strictly_better


def _heuristic_minutes(graph: nx.MultiDiGraph, node: Any, goal: Any,
                       speed_mps: float) -> float:
    a, b = graph.nodes[node], graph.nodes[goal]
    distance = haversine_m(float(a["y"]), float(a["x"]),
                           float(b["y"]), float(b["x"]))
    return distance / speed_mps / 60.0


def _insert_nondominated(bucket: list[Label], candidate: Label) -> bool:
    for old in bucket:
        if old.active and (_dominates(old, candidate) or (
            math.isclose(old.time_min, candidate.time_min, abs_tol=1e-9)
            and math.isclose(old.walk_m, candidate.walk_m, abs_tol=1e-9)
            and math.isclose(old.uncertainty, candidate.uncertainty, abs_tol=1e-9))):
            return False
    for old in bucket:
        if old.active and _dominates(candidate, old):
            old.active = False
    bucket.append(candidate)
    return True


def _edge_assessment(data: dict, wheelchair_user: bool, unknown_policy: str) -> tuple[bool, float, str, str]:
    return evaluate_edge(data, wheelchair_user=wheelchair_user,
                         unknown_policy=unknown_policy)


def _reconstruct_and_validate(graph: nx.MultiDiGraph, label: Label,
                              *, wheelchair_user: bool, unknown_policy: str,
                              walking_speed_mps: float, expansions: int,
                              search_complete: bool, label_cap_hit: bool,
                              blocked_entity_ids: frozenset[str]) -> dict:
    nodes = [label.path[0][0]] if label.path else [label.node]
    nodes.extend(v for _, v, _ in label.path)
    if len(nodes) != len(label.path) + 1:
        raise RuntimeError("ROUTE_RECONSTRUCTION_FAILED: node/edge count mismatch")
    total_distance = total_time = total_uncertainty = 0.0
    unknown_count = 0
    edge_records = []
    warnings = []
    coordinates: list[list[float]] = []

    for index, (u, v, key) in enumerate(label.path):
        if not graph.has_edge(u, v, key):
            raise RuntimeError(f"ROUTE_EDGE_MISSING: reconstructed edge {(u, v, key)!r} is absent")
        data = graph.edges[u, v, key]
        if edge_is_blocked(blocked_entity_ids, u, v, key, data):
            raise RuntimeError(f"ROUTE_CONTAINS_DISRUPTED_EDGE: {(u, v, key)!r}")
        if node_is_blocked(blocked_entity_ids, v, graph.nodes[v]):
            raise RuntimeError(f"ROUTE_CONTAINS_DISRUPTED_NODE: {v!r}")
        allowed, penalty, status, reason = _edge_assessment(data, wheelchair_user, unknown_policy)
        if not allowed:
            raise RuntimeError(f"ROUTE_CONTAINS_FORBIDDEN_EDGE: {(u, v, key)!r}")
        length = _edge_length(data)
        minutes = _edge_minutes(data, walking_speed_mps)
        total_distance += length
        total_time += minutes
        total_uncertainty += penalty
        if status == "UNKNOWN" and wheelchair_user:
            unknown_count += 1
        edge_records.append({
            "from": u, "to": v, "key": key,
            "mode": "walk", "distance_m": round(length, 2),
            "duration_min": round(minutes, 3),
            "accessibility": status, "reason_code": reason,
            "osm_tags": {tag: get_tag(data, tag) for tag in
                         ("wheelchair", "highway", "surface", "smoothness", "incline", "kerb", "width")
                         if get_tag(data, tag) != "unknown"},
        })
        segment = _edge_points(data.get("geometry"))
        if not segment:
            segment = [[float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])],
                       [float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])]]
        # OSMnx edge geometry normally follows u->v; guard against reversed geometry.
        if len(segment) >= 2:
            ux, uy = float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])
            vx, vy = float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])
            forward_error = math.hypot(segment[0][0]-ux, segment[0][1]-uy) + math.hypot(segment[-1][0]-vx, segment[-1][1]-vy)
            reverse_error = math.hypot(segment[-1][0]-ux, segment[-1][1]-uy) + math.hypot(segment[0][0]-vx, segment[0][1]-vy)
            if reverse_error < forward_error:
                segment.reverse()
        if coordinates and segment and coordinates[-1] == segment[0]:
            segment = segment[1:]
        coordinates.extend(segment)

    if unknown_count:
        warnings.append(f"{unknown_count} route edge(s) have unknown wheelchair accessibility.")
    if not coordinates and nodes:
        coordinates = [[float(graph.nodes[n]["x"]), float(graph.nodes[n]["y"])] for n in nodes]

    route_identity = json.dumps([[str(u), str(v), str(k)] for u, v, k in label.path], separators=(",", ":"))
    route_id = hashlib.sha1(route_identity.encode()).hexdigest()[:12]
    return {
        "route_id": route_id,
        "nodes": nodes,
        "edges": edge_records,
        "metrics": {
            "duration_min": round(total_time, 2),
            "walking_distance_m": round(total_distance, 1),
            "uncertainty_points": round(total_uncertainty, 1),
            "unknown_accessibility_edges": unknown_count,
            "transfer_count": 0,
        },
        "accessibility": {
            "status": "uncertain" if unknown_count else "tag_supported",
            "policy": unknown_policy,
            "wheelchair_profile": wheelchair_user,
            "warnings": warnings,
        },
        "geometry": {"type": "LineString", "coordinates": coordinates},
        "diagnostics": {"search_expansions": expansions,
                        "search_complete": search_complete,
                        "label_cap_hit": label_cap_hit},
    }


def route_candidates(graph: nx.MultiDiGraph, start: Any, goal: Any, *,
                     wheelchair_user: bool = True, unknown_policy: str = "strict",
                     max_walking_m: float = 3000.0, walking_speed_mps: float = 1.0,
                     max_routes: int = 3, max_expansions: int = 250_000,
                     max_labels_per_node: int = 100,
                     blocked_entity_ids: Any = ()) -> list[dict]:
    """Return up to N Pareto alternatives. Search is bounded by expansion/label caps."""
    if not isinstance(graph, nx.MultiDiGraph):
        raise TypeError("Routing requires a directed NetworkX MultiDiGraph")
    if start not in graph or goal not in graph:
        raise ValueError("START_OR_GOAL_NOT_IN_GRAPH")
    if unknown_policy not in {"strict", "relaxed"}:
        raise ValueError("unknown_policy must be 'strict' or 'relaxed'")
    if not math.isfinite(max_walking_m) or max_walking_m < 0:
        raise ValueError("max_walking_m must be finite and non-negative")
    if not math.isfinite(walking_speed_mps) or walking_speed_mps <= 0:
        raise ValueError("walking_speed_mps must be positive and finite")
    if max_routes < 1 or max_expansions < 1 or max_labels_per_node < 1:
        raise ValueError("Search limits must be positive integers")
    blocked = normalize_blocked_entities(blocked_entity_ids)
    if node_is_blocked(blocked, start, graph.nodes[start]) or node_is_blocked(
        blocked, goal, graph.nodes[goal]
    ):
        return []

    if start == goal:
        zero = Label(start, 0, 0, 0, 0, ())
        return [_reconstruct_and_validate(graph, zero, wheelchair_user=wheelchair_user,
                    unknown_policy=unknown_policy, walking_speed_mps=walking_speed_mps,
                    expansions=0, search_complete=True, label_cap_hit=False,
                    blocked_entity_ids=blocked)]

    labels_at: dict[Any, list[Label]] = {node: [] for node in graph.nodes}
    initial = Label(start, 0.0, 0.0, 0.0, 0, ())
    labels_at[start].append(initial)
    serial = count()
    queue: list[tuple[float, int, Label]] = []
    heapq.heappush(queue, (_heuristic_minutes(graph, start, goal, walking_speed_mps), next(serial), initial))
    goals: list[Label] = []
    expansions = 0
    label_cap_hit = False

    while queue and expansions < max_expansions:
        _, _, current = heapq.heappop(queue)
        if not current.active:
            continue
        expansions += 1
        if current.node == goal:
            _insert_nondominated(goals, current)
            continue
        for neighbor, keyed_edges in graph[current.node].items():
            if node_is_blocked(blocked, neighbor, graph.nodes[neighbor]):
                continue
            for edge_key, data in keyed_edges.items():
                if edge_is_blocked(blocked, current.node, neighbor, edge_key, data):
                    continue
                allowed, penalty, status, _ = _edge_assessment(data, wheelchair_user, unknown_policy)
                if not allowed:
                    continue
                length = _edge_length(data)
                new_walk = current.walk_m + length
                if new_walk > max_walking_m:
                    continue
                candidate = Label(
                    neighbor,
                    current.time_min + _edge_minutes(data, walking_speed_mps),
                    new_walk,
                    current.uncertainty + penalty,
                    current.unknown_edge_count + (1 if status == "UNKNOWN" and wheelchair_user else 0),
                    current.path + ((current.node, neighbor, edge_key),),
                )
                bucket = labels_at[neighbor]
                if not _insert_nondominated(bucket, candidate):
                    continue
                active = [item for item in bucket if item.active]
                if len(active) > max_labels_per_node:
                    label_cap_hit = True
                    # This cap is a safety valve: beyond it, search is bounded
                    # and may omit some Pareto alternatives. Reported in docs.
                    worst = max(active, key=lambda item: (item.time_min + item.uncertainty, item.walk_m))
                    worst.active = False
                    if worst is candidate:
                        continue
                priority = candidate.time_min + _heuristic_minutes(graph, neighbor, goal, walking_speed_mps)
                heapq.heappush(queue, (priority, next(serial), candidate))

    expansion_limit_hit = expansions >= max_expansions and any(item[2].active for item in queue)
    search_complete = not expansion_limit_hit and not label_cap_hit
    results = [item for item in goals if item.active]
    results.sort(key=lambda item: (item.uncertainty > 0, item.time_min, item.walk_m, item.uncertainty))
    return [_reconstruct_and_validate(graph, item, wheelchair_user=wheelchair_user,
                unknown_policy=unknown_policy, walking_speed_mps=walking_speed_mps,
                expansions=expansions, search_complete=search_complete,
                label_cap_hit=label_cap_hit,
                blocked_entity_ids=blocked) for item in results[:max_routes]]
