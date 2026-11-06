"""Door-to-door journeys across Chennai transit and the SRM walking graph."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from typing import Any

import networkx as nx

from .accessibility import evaluate_edge
from .evidence import decide
from .catalog import BLOCK_RADIUS_M, blocked_locations, expand_blocked
from .graph import haversine_m
from .router import route_candidates
from .service import RouteRequestError, _integer, _number
from .status import edge_is_blocked, node_is_blocked
from .street_paths import StreetWalker
from .transit import Ride, TransitNetwork


IST = timezone(timedelta(hours=5, minutes=30))
MODES = ("bus", "metro", "rail")
MODE_SETS = (
    ("bus", "metro", "rail"), ("metro", "rail"), ("bus", "metro"), ("bus", "rail"),
    ("bus",), ("metro",), ("rail",),
)
MODE_NAMES = {"bus": "Bus", "metro": "Metro", "rail": "Suburban rail"}
WALK_DETOUR = 1.3
MAX_ACCESS_WALK_M = 1500.0
CAMPUS_SNAP_M = 250.0
MIN_STREET_PATH_M = 40.0


@dataclass(frozen=True)
class Point:
    name: str
    lat: float
    lon: float

    def payload(self) -> dict[str, Any]:
        return {"name": self.name, "latitude": self.lat, "longitude": self.lon}


@dataclass(frozen=True)
class WalkLink:
    distance_m: float
    source: str


def _clock(value: int) -> str:
    value %= 86_400
    return f"{value // 3600:02d}:{value % 3600 // 60:02d}"


def _point_from(payload: Any, name: str) -> Point:
    if not isinstance(payload, dict):
        raise RouteRequestError(f"{name} must be an object")
    label = payload.get("name")
    return Point(
        label if isinstance(label, str) and label.strip() else name.title(),
        _number(payload.get("latitude"), f"{name}.latitude", minimum=-90, maximum=90),
        _number(payload.get("longitude"), f"{name}.longitude", minimum=-180, maximum=180),
    )


def _departure(value: Any) -> datetime:
    if value is None:
        return datetime.now(IST)
    if not isinstance(value, str):
        raise RouteRequestError("departure_time must be an ISO 8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RouteRequestError("departure_time must be an ISO 8601 string") from exc
    if parsed.tzinfo is None:
        raise RouteRequestError("departure_time must include a timezone")
    return parsed.astimezone(IST)


class CampusWalker:
    """Measure walking inside the SRM graph instead of estimating it."""

    def __init__(self, graph: nx.MultiDiGraph, connected: list[Any], wheelchair: bool,
                 blocked: frozenset[str], speed_mps: float) -> None:
        self.graph = graph
        self.connected = connected
        self.wheelchair = wheelchair
        self.blocked = blocked
        self.speed_mps = speed_mps

    def locate(self, lat: float, lon: float) -> tuple[Any, float] | None:
        """Snap to the main path network; small fragments do not reach anywhere."""
        best, best_distance = None, CAMPUS_SNAP_M
        for node in self.connected:
            data = self.graph.nodes[node]
            distance = haversine_m(lat, lon, float(data["y"]), float(data["x"]))
            if distance <= best_distance:
                best, best_distance = node, distance
        return None if best is None else (best, round(best_distance, 2))

    def distances(self, node: Any, *, towards: bool) -> dict[Any, float]:
        graph = self.graph.reverse(copy=False) if towards else self.graph

        def weight(u: Any, v: Any, edges: dict[Any, dict[str, Any]]) -> float | None:
            source, target = (v, u) if towards else (u, v)
            if node_is_blocked(self.blocked, v, graph.nodes[v]):
                return None
            lengths = [
                float(data["length"]) for key, data in edges.items()
                if not edge_is_blocked(self.blocked, source, target, key, data)
                and evaluate_edge(data, wheelchair_user=self.wheelchair, unknown_policy="relaxed")[0]
            ]
            return min(lengths) if lengths else None

        return nx.single_source_dijkstra_path_length(graph, node, weight=weight)

    def path(self, start: Any, goal: Any) -> list[list[float]] | None:
        routes = route_candidates(
            self.graph, start, goal,
            wheelchair_user=self.wheelchair, unknown_policy="relaxed",
            max_walking_m=10_000, walking_speed_mps=self.speed_mps, max_routes=1,
            blocked_entity_ids=self.blocked,
        )
        return routes[0]["geometry"]["coordinates"] if routes else None


class JourneyPlanner:
    def __init__(self, network: TransitNetwork, campus_graph: nx.MultiDiGraph | None = None,
                 graph_version: str | None = None, street_walker: StreetWalker | None = None) -> None:
        self.network = network
        self.campus_graph = campus_graph
        self.graph_version = graph_version
        self.street_walker = street_walker
        self.connected_nodes = (
            list(max(nx.strongly_connected_components(campus_graph), key=len))
            if campus_graph is not None else []
        )

    def plan(self, payload: Any, *, blocked_entity_ids: Any = (), status_overlay: dict | None = None) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RouteRequestError("request body must be a JSON object")
        profile = payload.get("profile", {})
        constraints = payload.get("constraints", {})
        if not isinstance(profile, dict) or not isinstance(constraints, dict):
            raise RouteRequestError("profile and constraints must be objects")
        origin = _point_from(payload.get("origin"), "origin")
        destination = _point_from(payload.get("destination"), "destination")
        departure = _departure(payload.get("departure_time"))
        speed = _number(profile.get("walking_speed_mps", 1.0), "walking_speed_mps", minimum=0.05)
        max_walk = _number(constraints.get("max_walking_distance_m", 2000), "max_walking_distance_m", minimum=0)
        max_routes = _integer(constraints.get("max_routes", 3), "max_routes", minimum=1, maximum=5)
        policy = profile.get("unknown_accessibility_policy", "relaxed")
        if policy not in {"strict", "relaxed"}:
            raise RouteRequestError("unknown_accessibility_policy must be 'strict' or 'relaxed'")
        wheelchair = profile.get("wheelchair_user", False)
        if not isinstance(wheelchair, bool):
            raise RouteRequestError("wheelchair_user must be a boolean")
        requires_lift_status = profile.get("requires_lift_status", wheelchair)
        if not isinstance(requires_lift_status, bool):
            raise RouteRequestError("requires_lift_status must be a boolean")
        modes = constraints.get("modes", list(MODES))
        if not isinstance(modes, list) or not modes or any(mode not in MODES for mode in modes):
            raise RouteRequestError("modes must list bus, metro or rail")

        request_id = str(payload.get("request_id") or "") or None
        base = {
            "request_id": request_id,
            "status_overlay": status_overlay or {"active_events": 0, "blocking_events": 0, "blocked_entity_ids": []},
            "transit": {"sources": self.network.sources},
        }
        if wheelchair and policy == "strict":
            return {**base, "status": "no_route", "journeys": [], "message": (
                "The Chennai bus, metro and suburban feeds publish no wheelchair-boarding data, so no "
                "journey can be verified. Turn off strict verification to see unverified options."
            )}

        blocked = expand_blocked(blocked_entity_ids, self.campus_graph)
        blocked_stops = self._blocked_stops(blocked)
        walker = (
            CampusWalker(self.campus_graph, self.connected_nodes, wheelchair, blocked, speed)
            if self.campus_graph is not None else None
        )
        seconds_now = departure.hour * 3600 + departure.minute * 60 + departure.second
        day_bit = 1 << departure.weekday()
        access = self._links(origin, walker, max_walk, blocked_stops, towards=False)
        egress = self._links(destination, walker, max_walk, blocked_stops, towards=True)

        journeys: dict[str, dict[str, Any]] = {}
        direct = self._direct(origin, destination, walker, seconds_now, speed, max_walk, wheelchair, blocked)
        if direct:
            journeys[direct["journey_id"]] = direct
        if access and egress:
            access_seconds = {stop: int(link.distance_m / speed) for stop, link in access.items()}
            egress_seconds = {stop: int(link.distance_m / speed) for stop, link in egress.items()}
            for mode_set in MODE_SETS:
                allowed = [mode for mode in mode_set if mode in modes]
                if not allowed:
                    continue
                for itinerary in self.network.search(
                    access_seconds, egress_seconds, seconds_now, day_bit, allowed, speed,
                    blocked_stops=blocked_stops,
                ):
                    journey = self._journey(
                        itinerary, origin, destination, access, egress, walker, speed, wheelchair,
                    )
                    if journey["metrics"]["walking_distance_m"] <= max_walk:
                        journeys.setdefault(journey["journey_id"], journey)

        ordered = self._select(list(journeys.values()), max_routes)
        for journey in ordered:
            journey["metrics"].pop("arrival_s")
        self._add_street_paths(ordered, speed)
        decision = decide(ordered, (status_overlay or {}).get("facility_assessment"),
                          requires_lift_status=requires_lift_status,
                          confirmation=(status_overlay or {}).get("operator_confirmation"))
        return {
            **base,
            "status": "ok" if ordered else "no_route",
            "journeys": ordered,
            "decision": decision,
            "message": None if ordered else self._no_route_message(modes, access, egress, destination, blocked),
        }

    @staticmethod
    def _select(journeys: list[dict[str, Any]], max_routes: int) -> list[dict[str, Any]]:
        """Show the fastest journey for each mode mix before filling with others."""
        ranked = sorted(journeys, key=lambda item: (item["metrics"]["arrival_s"], item["metrics"]["transfers"]))
        chosen: list[dict[str, Any]] = []
        seen: set[tuple[str, ...]] = set()
        for journey in ranked:
            mix = tuple(journey["modes"])
            if mix not in seen and len(chosen) < max_routes:
                seen.add(mix)
                chosen.append(journey)
        for journey in ranked:
            if journey not in chosen and len(chosen) < max_routes:
                chosen.append(journey)
        return sorted(chosen, key=lambda item: item["metrics"]["arrival_s"])

    def _no_route_message(self, modes: list[str], access: dict[int, WalkLink], egress: dict[int, WalkLink],
                          destination: Point, blocked: frozenset[str]) -> str:
        names = " or ".join(MODE_NAMES[mode] for mode in modes)
        disrupted = blocked_locations(blocked)
        if disrupted:
            places = ", ".join(place["name"] for place in disrupted)
            return f"A reported disruption at {places} leaves no usable journey. Try another destination or a later time."
        reach_start = any(self.network.stops[stop].mode in modes for stop in access)
        reach_end = any(self.network.stops[stop].mode in modes for stop in egress)
        if not reach_start:
            return f"{names} has no stop within your walking limit of the starting point. Try another mode or raise the limit."
        if not reach_end:
            return f"{names} has no stop within your walking limit of {destination.name}. Try another mode or raise the limit."
        return f"No {names} journey is available at this time. Try a later time or another mode."

    def _blocked_stops(self, blocked: frozenset[str]) -> frozenset[int]:
        stops: set[int] = set()
        for place in blocked_locations(blocked):
            stops.update(stop for stop, _ in self.network.nearby_stops(
                place["latitude"], place["longitude"], BLOCK_RADIUS_M, limit=50,
            ))
        return frozenset(stops)

    def _add_street_paths(self, journeys: list[dict[str, Any]], speed: float) -> None:
        """Replace estimated walks with real street paths, keeping estimates on failure."""
        if self.street_walker is None:
            return
        legs = [
            leg for journey in journeys for leg in journey["legs"]
            if leg.get("walk_source") == "estimated" and leg["distance_m"] >= MIN_STREET_PATH_M
        ]
        if not legs:
            return

        def request(leg: dict[str, Any]) -> tuple[float, list[list[float]]] | None:
            start, end = leg["from"], leg["to"]
            return self.street_walker.path((start["latitude"], start["longitude"]), (end["latitude"], end["longitude"]))

        with ThreadPoolExecutor(max_workers=6) as pool:
            paths = list(pool.map(request, legs))
        for leg, path in zip(legs, paths):
            if path is None:
                continue
            distance, geometry = path
            leg.update(
                distance_m=round(distance, 1), duration_min=round(distance / speed / 60, 1),
                geometry=geometry, walk_source="street_path",
            )
        for journey in journeys:
            walks = [leg for leg in journey["legs"] if leg["mode"] == "walk"]
            journey["metrics"]["walking_distance_m"] = round(sum(leg["distance_m"] for leg in walks), 1)
            if not any(leg.get("walk_source") == "estimated" for leg in walks):
                journey["notes"] = [note for note in journey["notes"] if not note.startswith("Walking outside")]

    def _links(self, point: Point, walker: CampusWalker | None, max_walk: float,
               blocked_stops: frozenset[int], *, towards: bool) -> dict[int, WalkLink]:
        radius = min(max_walk / WALK_DETOUR, MAX_ACCESS_WALK_M)
        nearby = self.network.nearby_stops(point.lat, point.lon, radius)
        located = walker.locate(point.lat, point.lon) if walker else None
        reachable = walker.distances(located[0], towards=towards) if walker and located else {}
        links: dict[int, WalkLink] = {}
        for stop_index, straight in nearby:
            if stop_index in blocked_stops:
                continue
            stop = self.network.stops[stop_index]
            snapped = walker.locate(stop.lat, stop.lon) if reachable and walker else None
            if snapped and snapped[0] in reachable:
                links[stop_index] = WalkLink(reachable[snapped[0]] + snapped[1] + located[1], "campus_graph")
            else:
                links[stop_index] = WalkLink(straight * WALK_DETOUR, "estimated")
        return links

    def _walk_leg(self, start: Point, end: Point, link: WalkLink, walker: CampusWalker | None,
                  speed: float, departure: int) -> dict[str, Any]:
        geometry = [[start.lon, start.lat], [end.lon, end.lat]]
        if link.source == "campus_graph" and walker:
            first, second = walker.locate(start.lat, start.lon), walker.locate(end.lat, end.lon)
            if first and second and first[0] != second[0]:
                path = walker.path(first[0], second[0])
                if path:
                    geometry = [[start.lon, start.lat], *path, [end.lon, end.lat]]
        duration = int(link.distance_m / speed)
        return {
            "mode": "walk",
            "from": start.payload(),
            "to": end.payload(),
            "departure": _clock(departure),
            "arrival": _clock(departure + duration),
            "duration_min": round(duration / 60, 1),
            "distance_m": round(link.distance_m, 1),
            "walk_source": link.source,
            "fare_inr": 0,
            "geometry": geometry,
        }

    def _ride_leg(self, ride: Ride) -> dict[str, Any]:
        pattern = self.network.patterns[ride.pattern]
        short_name, long_name, mode = self.network.routes[pattern.route]
        indices = pattern.stops[ride.board:ride.alight + 1]
        stops = [self.network.stops[index] for index in indices]
        departure = pattern.times[ride.board][ride.trip]
        arrival = pattern.times[ride.alight][ride.trip]
        distance = sum(haversine_m(a.lat, a.lon, b.lat, b.lon) for a, b in zip(stops, stops[1:]))
        fare = self.network.metro_fare(indices[0], indices[-1]) if mode == "metro" else None
        return {
            "mode": mode,
            "from": Point(stops[0].name, stops[0].lat, stops[0].lon).payload(),
            "to": Point(stops[-1].name, stops[-1].lat, stops[-1].lon).payload(),
            "departure": _clock(departure),
            "arrival": _clock(arrival),
            "duration_min": round((arrival - departure) / 60, 1),
            "distance_m": round(distance, 1),
            "route_name": short_name or long_name,
            "route_description": long_name,
            "stop_count": len(stops) - 1,
            "fare_inr": fare,
            "geometry": self.network.ride_path(pattern, ride.board, ride.alight),
            "_departure_s": departure,
            "_arrival_s": arrival,
        }

    def _stop_point(self, index: int) -> Point:
        stop = self.network.stops[index]
        return Point(stop.name, stop.lat, stop.lon)

    def _journey(self, itinerary: Any, origin: Point, destination: Point, access: dict[int, WalkLink],
                 egress: dict[int, WalkLink], walker: CampusWalker | None, speed: float,
                 wheelchair: bool) -> dict[str, Any]:
        rides = [self._ride_leg(value) for kind, value in itinerary.steps if kind == "ride"]
        first_link = access[itinerary.access_stop]
        leave = rides[0]["_departure_s"] - int(first_link.distance_m / speed) - 60
        legs = [self._walk_leg(origin, self._stop_point(itinerary.access_stop), first_link, walker, speed, leave)]
        ride_position = 0
        for kind, value in itinerary.steps:
            if kind == "ride":
                legs.append(rides[ride_position])
                ride_position += 1
            else:
                start, end, distance = value
                legs.append(self._walk_leg(
                    self._stop_point(start), self._stop_point(end), WalkLink(distance, "estimated"),
                    None, speed, legs[-1].get("_arrival_s", 0),
                ))
        arrival_at_stop = rides[-1]["_arrival_s"]
        last_steps = itinerary.steps[-1]
        if last_steps[0] == "walk":
            arrival_at_stop += int(last_steps[1][2] / speed)
        legs.append(self._walk_leg(
            self._stop_point(itinerary.egress_stop), destination, egress[itinerary.egress_stop],
            walker, speed, arrival_at_stop,
        ))
        legs = [leg for leg in legs if leg["mode"] != "walk" or leg["distance_m"] >= 1]
        signature = [[leg["mode"], leg.get("route_name"), leg["from"]["name"], leg["to"]["name"]] for leg in rides]
        for leg in legs:
            leg.pop("_departure_s", None)
            leg.pop("_arrival_s", None)
        return self._summary(legs, signature, leave, itinerary.arrival, len(rides) - 1, wheelchair)

    def _direct(self, origin: Point, destination: Point, walker: CampusWalker | None, now: int,
                speed: float, max_walk: float, wheelchair: bool,
                blocked: frozenset[str]) -> dict[str, Any] | None:
        straight = haversine_m(origin.lat, origin.lon, destination.lat, destination.lon)
        link = WalkLink(straight * WALK_DETOUR, "estimated")
        if walker:
            first, second = walker.locate(origin.lat, origin.lon), walker.locate(destination.lat, destination.lon)
            if first and second:
                measured = walker.distances(first[0], towards=False).get(second[0])
                if measured is not None:
                    link = WalkLink(measured + first[1] + second[1], "campus_graph")
                elif blocked or wheelchair:
                    return None  # Disruptions or the profile leave no walkable path.
        if link.distance_m > max_walk:
            return None
        leg = self._walk_leg(origin, destination, link, walker, speed, now)
        return self._summary([leg], [["walk", None, origin.name, destination.name]],
                             now, now + int(link.distance_m / speed), 0, wheelchair)

    def _summary(self, legs: list[dict[str, Any]], signature: list[Any], leave: int, arrival: int,
                 transfers: int, wheelchair: bool) -> dict[str, Any]:
        transit_legs = [leg for leg in legs if leg["mode"] != "walk"]
        unknown_fares = sorted({leg["mode"] for leg in transit_legs if leg["fare_inr"] is None})
        known_fare = sum(leg["fare_inr"] for leg in legs if leg["fare_inr"] is not None)
        walking = sum(leg["distance_m"] for leg in legs if leg["mode"] == "walk")
        notes: list[str] = []
        if any(leg["mode"] == "metro" for leg in legs):
            notes.append("Metro times are a typical schedule: the published CMRL timetable ended in 2021.")
        if unknown_fares:
            names = {"bus": "MTC bus", "rail": "suburban rail", "metro": "metro"}
            notes.append("Fares are not published in the " + " and ".join(names[mode] for mode in unknown_fares)
                         + " data, so the total is incomplete.")
        if any(leg.get("walk_source") == "estimated" for leg in legs):
            notes.append("Walking outside mapped paths is estimated from straight-line distance.")
        warnings = ["Wheelchair access is unverified: these feeds publish no boarding accessibility data."] \
            if wheelchair and transit_legs else []
        identity = json.dumps(signature, separators=(",", ":"))
        return {
            "journey_id": hashlib.sha1(identity.encode()).hexdigest()[:12],
            "departure": _clock(leave),
            "arrival": _clock(arrival),
            "metrics": {
                "duration_min": round((arrival - leave) / 60, 1),
                "walking_distance_m": round(walking, 1),
                "transfers": max(transfers, 0),
                "arrival_s": arrival,
            },
            "fare": {"known_inr": known_fare, "complete": not unknown_fares, "unknown_modes": unknown_fares},
            "modes": sorted({leg["mode"] for leg in legs}),
            "legs": legs,
            "accessibility": {"status": "uncertain", "wheelchair_profile": wheelchair, "warnings": warnings},
            "notes": notes,
        }
