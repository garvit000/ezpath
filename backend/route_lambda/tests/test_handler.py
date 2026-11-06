import json

import networkx as nx

from backend.route_lambda.handler import handle_event
from backend.route_lambda.status_overlay import StatusSnapshot
from routing.service import RoutingService


def _service() -> RoutingService:
    graph = nx.MultiDiGraph()
    graph.graph.update(
        crs="EPSG:4326",
        routing_graph_version="lambda-test-v1",
        routing_source="synthetic Lambda adapter test",
    )
    graph.add_node(1, x=0.0, y=0.0)
    graph.add_node(2, x=0.001, y=0.0)
    graph.add_edge(1, 2, key=0, length=111.2, wheelchair="yes", elevator_id="lift-a1")
    return RoutingService(graph)


def _event(payload) -> dict:
    return {
        "version": "2.0",
        "routeKey": "POST /v1/routes",
        "body": json.dumps(payload),
        "isBase64Encoded": False,
    }


def test_route_request_returns_api_gateway_response():
    response = handle_event(
        _event(
            {
                "request_id": "lambda-test-1",
                "origin": {"latitude": 0.0, "longitude": 0.0},
                "destination": {"latitude": 0.0, "longitude": 0.001},
                "profile": {
                    "wheelchair_user": True,
                    "unknown_accessibility_policy": "strict",
                },
                "constraints": {
                    "max_snap_distance_m": 30,
                    "max_walking_distance_m": 500,
                    "max_routes": 3,
                },
            }
        ),
        _service(),
    )

    assert response["statusCode"] == 200
    payload = json.loads(response["body"])
    assert payload["request_id"] == "lambda-test-1"
    assert payload["status"] == "ok"
    assert payload["graph"]["version"] == "lambda-test-v1"
    assert payload["routes"][0]["accessibility"]["status"] == "tag_supported"


def test_invalid_json_returns_400():
    response = handle_event({"body": "{"}, _service())

    assert response["statusCode"] == 400
    payload = json.loads(response["body"])
    assert payload["error"]["code"] == "ROUTE_REQUEST_INVALID"


def test_health_returns_loaded_graph_metadata():
    response = handle_event({"routeKey": "GET /health"}, _service())

    assert response["statusCode"] == 200
    payload = json.loads(response["body"])
    assert payload == {
        "status": "ok",
        "graph_version": "lambda-test-v1",
        "nodes": 2,
        "edges": 1,
    }


def test_snap_distance_error_returns_422():
    response = handle_event(
        _event(
            {
                "origin": {"latitude": 1.0, "longitude": 1.0},
                "destination": {"latitude": 0.0, "longitude": 0.001},
                "constraints": {"max_snap_distance_m": 10},
            }
        ),
        _service(),
    )

    assert response["statusCode"] == 422


class FakeStatusProvider:
    def get_snapshot(self):
        return StatusSnapshot(
            active_event_ids=("event-1",),
            blocking_event_ids=("event-1",),
            blocked_entity_ids=frozenset({"lift-a1"}),
        )


def test_active_disruption_is_applied_to_route_request():
    response = handle_event(
        _event(
            {
                "origin": {"latitude": 0.0, "longitude": 0.0},
                "destination": {"latitude": 0.0, "longitude": 0.001},
                "profile": {"unknown_accessibility_policy": "relaxed"},
                "constraints": {"max_snap_distance_m": 30},
            }
        ),
        _service(),
        FakeStatusProvider(),
    )

    assert response["statusCode"] == 200
    payload = json.loads(response["body"])
    assert payload["status"] == "no_route"
    assert payload["status_overlay"] == {
        "active_events": 1,
        "blocking_events": 1,
        "blocked_entity_ids": ["lift-a1"],
        "facility_assessment": None,
        "operator_confirmation": None,
    }


def test_status_failure_returns_503_instead_of_potentially_stale_route():
    class FailingProvider:
        def get_snapshot(self):
            raise RuntimeError("DynamoDB unavailable")

    response = handle_event(_event({}), _service(), FailingProvider())

    assert response["statusCode"] == 503
    assert json.loads(response["body"])["error"]["code"] == "STATUS_OVERLAY_UNAVAILABLE"


class _FakePlanner:
    def __init__(self) -> None:
        self.blocked = None

    def plan(self, payload, *, blocked_entity_ids=(), status_overlay=None):
        self.blocked = blocked_entity_ids
        return {"status": "ok", "journeys": [], "request_id": payload.get("request_id")}


def _journey_event(payload) -> dict:
    return {**_event(payload), "routeKey": "POST /v1/journeys"}


def test_journey_route_uses_the_planner():
    planner = _FakePlanner()

    response = handle_event(_journey_event({"request_id": "journey-1"}), _service(), None, planner)

    assert response["statusCode"] == 200
    assert json.loads(response["body"])["request_id"] == "journey-1"


def test_journey_route_reports_missing_transit_data():
    response = handle_event(_journey_event({}), _service(), None, None)

    assert response["statusCode"] == 503
    assert json.loads(response["body"])["error"]["code"] == "TRANSIT_DATA_UNAVAILABLE"


def test_journey_route_passes_live_blocks_to_the_planner():
    class Status:
        def get_snapshot(self):
            return StatusSnapshot(("event-1",), ("event-1",), frozenset({"node:1"}))

    planner = _FakePlanner()

    handle_event(_journey_event({}), _service(), Status(), planner)

    assert planner.blocked == frozenset({"node:1"})


def test_public_evidence_endpoint_exposes_simulation_without_operator_identity():
    class Status:
        def get_snapshot(self):
            return StatusSnapshot((), (), frozenset(),
                {"facilityId": "rail-potheri", "quality": "SUSPECT", "effectiveState": "UNKNOWN",
                 "flags": ["FROZEN_SEQUENCE"], "simulated": True},
                {"state": "OPERATIONAL", "confirmedAt": "2026-11-06T10:00:00Z", "expiresAt": 9999999999})

    response = handle_event({"routeKey": "GET /v1/telemetry/evidence"}, _service(), Status())

    assert response["statusCode"] == 200
    evidence = json.loads(response["body"])
    assert evidence["quality"] == "SUSPECT"
    assert evidence["operatorConfirmation"]["state"] == "OPERATIONAL"
    assert "operatorId" not in response["body"]
