from __future__ import annotations

import gzip
import json

import networkx as nx
import pytest

from routing.catalog import expand_blocked
from routing.journeys import JourneyPlanner
from routing.router import _edge_points
from routing.shapes import simplify, stop_offsets
from routing.street_paths import StreetWalker
from routing.service import RouteRequestError
from routing.transit import TransitNetwork
from routing.transit_build import FeedSource, build_artifact, write_artifact


def write_feed(folder, mode_type, stops, trips, stop_times, calendar=True):
    folder.mkdir(parents=True)
    (folder / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon,zone_id,parent_station\n" + stops, encoding="utf-8")
    (folder / "routes.txt").write_text(
        f"route_id,route_short_name,route_long_name,route_type\nR1,L1,Line One,{mode_type}\n", encoding="utf-8")
    (folder / "trips.txt").write_text("route_id,service_id,trip_id\n" + trips, encoding="utf-8")
    (folder / "stop_times.txt").write_text("trip_id,stop_id,stop_sequence,arrival_time,departure_time\n" + stop_times, encoding="utf-8")
    if calendar:
        (folder / "calendar.txt").write_text(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "ALL,1,1,1,1,1,1,1,20250101,20991231\n", encoding="utf-8")


@pytest.fixture
def network(tmp_path):
    metro = tmp_path / "metro"
    write_feed(
        metro, 1,
        "M1,Alpha,13.0000,80.2000,ZA,\nM2,Bravo,13.0300,80.2000,ZB,\n",
        "R1,ALL,T1\nR1,ALL,T2\n",
        "T1,M1,1,09:00:00,09:00:00\nT1,M2,2,09:10:00,09:10:00\n"
        "T2,M1,1,10:00:00,10:00:00\nT2,M2,2,10:10:00,10:10:00\n",
    )
    (metro / "fare_attributes.txt").write_text("fare_id,price\nF1,30\n", encoding="utf-8")
    (metro / "fare_rules.txt").write_text("fare_id,route_id,origin_id,destination_id\nF1, ,ZA,ZB\n", encoding="utf-8")
    bus = tmp_path / "bus"
    write_feed(
        bus, 3,
        "B1,Bravo Bus,13.0305,80.2000,,\nB2,Charlie,13.0600,80.2000,,\n",
        "R1,ALL,T1\n",
        "T1,B1,1,09:20:00,09:20:00\nT1,B2,2,09:40:00,09:40:00\n",
    )
    artifact = build_artifact([
        FeedSource("metro", "Metro", "metro", metro),
        FeedSource("bus", "Bus", "bus", bus),
    ])
    path = tmp_path / "transit.json.gz"
    write_artifact(artifact, path)
    return TransitNetwork.load(path)


def request(**overrides):
    payload = {
        "origin": {"name": "Start", "latitude": 13.0000, "longitude": 80.2002},
        "destination": {"name": "End", "latitude": 13.0600, "longitude": 80.2002},
        "departure_time": "2026-11-09T08:50:00+05:30",
        "profile": {"wheelchair_user": False, "unknown_accessibility_policy": "relaxed"},
        "constraints": {"max_walking_distance_m": 1500},
    }
    payload.update(overrides)
    return payload


def test_builds_a_transfer_journey_with_times_and_partial_fare(network):
    response = JourneyPlanner(network).plan(request())

    assert response["status"] == "ok"
    journey = response["journeys"][0]
    assert [leg["mode"] for leg in journey["legs"]] == ["walk", "metro", "walk", "bus", "walk"]
    assert journey["metrics"]["transfers"] == 1
    assert journey["legs"][1]["departure"] == "09:00"
    assert journey["legs"][3]["arrival"] == "09:40"
    assert journey["fare"] == {"known_inr": 30, "complete": False, "unknown_modes": ["bus"]}
    assert any("not published" in note for note in journey["notes"])


def test_mode_filter_removes_journeys_that_need_the_mode(network):
    response = JourneyPlanner(network).plan(request(constraints={"max_walking_distance_m": 1500, "modes": ["metro"]}))

    assert response["status"] == "no_route"


def test_strict_wheelchair_profile_never_claims_verified_transit(network):
    response = JourneyPlanner(network).plan(request(profile={"wheelchair_user": True, "unknown_accessibility_policy": "strict"}))

    assert response["status"] == "no_route"
    assert "no wheelchair-boarding data" in response["message"]


def test_relaxed_wheelchair_profile_warns_on_transit(network):
    response = JourneyPlanner(network).plan(request(profile={"wheelchair_user": True, "unknown_accessibility_policy": "relaxed"}))

    assert response["journeys"][0]["accessibility"]["status"] == "uncertain"
    assert response["journeys"][0]["accessibility"]["warnings"]


def test_walking_limit_is_a_hard_constraint(network):
    response = JourneyPlanner(network).plan(request(constraints={"max_walking_distance_m": 10}))

    assert response["status"] == "no_route"


def test_requires_a_timezone_on_departure(network):
    with pytest.raises(RouteRequestError):
        JourneyPlanner(network).plan(request(departure_time="2026-11-09T08:50:00"))


def test_after_midnight_times_never_arrive_before_departure(tmp_path):
    feed = tmp_path / "rail"
    write_feed(
        feed, 2,
        "S1,Late One,13.0000,80.2000,,\nS2,Late Two,13.0300,80.2000,,\n",
        "R1,ALL,T1\n",
        "T1,S1,1,23:50:00,23:50:00\nT1,S2,2,00:10:00,00:10:00\n",
    )

    artifact = build_artifact([FeedSource("rail", "Rail", "rail", feed)])

    assert artifact["patterns"][0]["times"] == [[85800], [87000]]


def test_campus_end_uses_measured_walking_graph(network):
    graph = nx.MultiDiGraph(crs="epsg:4326")
    graph.add_node(1, x=80.2000, y=13.0600)
    graph.add_node(2, x=80.2010, y=13.0600)
    for u, v in ((1, 2), (2, 1)):
        graph.add_edge(u, v, key=0, length=500.0, highway="footway", osmid=u)

    response = JourneyPlanner(network, graph).plan(request(
        destination={"name": "Campus", "latitude": 13.0600, "longitude": 80.2010},
    ))

    assert response["journeys"][0]["legs"][-1]["walk_source"] == "campus_graph"
    assert response["journeys"][0]["legs"][-1]["distance_m"] == pytest.approx(500, abs=1)


def test_artifact_is_gzip_json(network, tmp_path):
    assert network.routes and network.patterns
    path = tmp_path / "check.json.gz"
    write_artifact({"schema_version": 1}, path)
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        assert json.load(handle) == {"schema_version": 1}


def test_request_and_response_match_published_schemas(network):
    jsonschema = pytest.importorskip("jsonschema")
    from pathlib import Path

    contracts = Path(__file__).resolve().parents[1] / "contracts"
    payload = request(request_id="schema-check")
    response = JourneyPlanner(network).plan(payload)

    jsonschema.Draft202012Validator(
        json.loads((contracts / "journey-request.schema.json").read_text(encoding="utf-8"))
    ).validate(payload)
    jsonschema.Draft202012Validator(
        json.loads((contracts / "journey-response.schema.json").read_text(encoding="utf-8"))
    ).validate(json.loads(json.dumps(response)))


def test_shows_the_fastest_journey_for_each_mode_mix(network):
    journeys = [
        {"modes": ["walk", "bus"], "metrics": {"arrival_s": 100, "transfers": 0}},
        {"modes": ["walk", "bus"], "metrics": {"arrival_s": 110, "transfers": 0}},
        {"modes": ["walk", "bus"], "metrics": {"arrival_s": 120, "transfers": 0}},
        {"modes": ["walk", "metro"], "metrics": {"arrival_s": 200, "transfers": 0}},
    ]

    chosen = JourneyPlanner._select(journeys, 2)

    assert [journey["metrics"]["arrival_s"] for journey in chosen] == [100, 200]


def test_no_route_message_names_the_missing_mode(network):
    response = JourneyPlanner(network).plan(request(
        constraints={"max_walking_distance_m": 1500, "modes": ["metro"]},
    ))

    assert response["status"] == "no_route"
    assert "Metro has no stop within your walking limit of End" in response["message"]


def test_blocked_stop_is_not_served(network, monkeypatch):
    bravo = next(index for index, stop in enumerate(network.stops) if stop.name == "Bravo")
    monkeypatch.setattr(JourneyPlanner, "_blocked_stops", lambda self, blocked: frozenset({bravo}))

    response = JourneyPlanner(network).plan(request())

    assert response["status"] == "no_route"


def test_street_paths_replace_estimated_walks(network):
    class Streets:
        def path(self, start, end):
            return 900.0, [[80.2, 13.0], [80.201, 13.001], [80.2, 13.002]]

    response = JourneyPlanner(network, street_walker=Streets()).plan(request())

    walks = [leg for leg in response["journeys"][0]["legs"] if leg.get("walk_source") == "street_path"]
    assert walks
    assert len(walks[0]["geometry"]) == 3


def test_failed_street_lookup_keeps_the_estimate(network):
    class Streets:
        def path(self, start, end):
            return None

    response = JourneyPlanner(network, street_walker=Streets()).plan(request())

    assert all(leg.get("walk_source") != "street_path" for leg in response["journeys"][0]["legs"])


def test_street_walker_reads_amazon_location_responses():
    class Client:
        def calculate_route(self, **kwargs):
            assert kwargs["TravelMode"] == "Walking"
            assert kwargs["DeparturePosition"] == [80.2, 13.0]
            return {
                "Summary": {"Distance": 0.5},
                "Legs": [{"Geometry": {"LineString": [[80.2, 13.0], [80.21, 13.01]]}}],
            }

    assert StreetWalker("calculator", Client()).path((13.0, 80.2), (13.01, 80.21)) == (
        500.0, [[80.2, 13.0], [80.21, 13.01]],
    )


def test_street_walker_returns_none_on_failure():
    class Client:
        def calculate_route(self, **kwargs):
            raise RuntimeError("service unavailable")

    assert StreetWalker("calculator", Client()).path((13.0, 80.2), (13.01, 80.21)) is None


def test_ride_path_uses_the_mapped_shape_between_stops(network):
    pattern = network.patterns[0]
    network.shapes.append([[80.2, 13.0], [80.21, 13.01], [80.2, 13.03]])
    pattern.shape = len(network.shapes) - 1
    pattern.offsets = [0, 2]

    assert network.ride_path(pattern, 0, 1) == [[80.2, 13.0], [80.21, 13.01], [80.2, 13.03]]


def test_graphml_geometry_text_is_used_for_campus_lines():
    assert _edge_points("LINESTRING (80.1 12.8, 80.2 12.9, 80.3 12.95)") == [
        [80.1, 12.8], [80.2, 12.9], [80.3, 12.95],
    ]


def test_disrupted_named_place_blocks_nearby_campus_nodes():
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=80.0425857, y=12.8232845)
    graph.add_node(2, x=80.0600000, y=12.8400000)

    assert "node:1" in expand_blocked(["srm-library"], graph)
    assert "node:2" not in expand_blocked(["srm-library"], graph)


def test_simplify_keeps_the_shape_and_drops_redundant_points():
    line = [[80.0, 13.0], [80.00001, 13.00001], [80.1, 13.1], [80.2, 13.0]]

    assert simplify(line) == [[80.0, 13.0], [80.1, 13.1], [80.2, 13.0]]


def test_stop_offsets_only_move_forward():
    shape = [[0.0, 0.0], [0.0, 0.01], [0.0, 0.02], [0.0, 0.03]]

    offsets, gaps = stop_offsets(shape, [[0.0, 0.0], [0.0, 0.021], [0.0, 0.03]])

    assert offsets == [0, 2, 3]
    assert max(gaps) < 200


def test_campus_walks_ignore_disconnected_path_fragments(network):
    graph = nx.MultiDiGraph(crs="epsg:4326")
    graph.add_node(1, x=80.2000, y=13.0600)
    graph.add_node(2, x=80.2010, y=13.0600)
    graph.add_node(3, x=80.2020, y=13.0600)
    graph.add_node(9, x=80.2002, y=13.0000)  # Fragment beside the origin.
    for u, v in ((1, 2), (2, 1), (2, 3), (3, 2)):
        graph.add_edge(u, v, key=0, length=110.0, highway="footway", osmid=u)

    planner = JourneyPlanner(network, graph)

    assert 9 not in planner.connected_nodes
