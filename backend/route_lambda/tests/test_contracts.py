import json
from pathlib import Path

import jsonschema
import networkx as nx
import yaml

from backend.route_lambda.handler import handle_event
from routing.service import RoutingService


ROOT = Path(__file__).resolve().parents[3]
REQUEST_SCHEMA = ROOT / "traversal" / "routing" / "contracts" / "route-request.schema.json"
RESPONSE_SCHEMA = ROOT / "traversal" / "routing" / "contracts" / "route-response.schema.json"
OPENAPI = ROOT / "contracts" / "openapi.yaml"


def _request() -> dict:
    return {
        "request_id": "contract-test-1",
        "origin": {"latitude": 0.0, "longitude": 0.0},
        "destination": {"latitude": 0.0, "longitude": 0.001},
        "profile": {
            "wheelchair_user": True,
            "unknown_accessibility_policy": "strict",
            "walking_speed_mps": 1.0,
        },
        "constraints": {
            "max_walking_distance_m": 500,
            "max_snap_distance_m": 30,
            "max_routes": 3,
        },
    }


def _service() -> RoutingService:
    graph = nx.MultiDiGraph()
    graph.graph.update(crs="EPSG:4326", routing_graph_version="contract-v1", routing_source="test")
    graph.add_node(1, x=0.0, y=0.0)
    graph.add_node(2, x=0.001, y=0.0)
    graph.add_edge(1, 2, key=0, length=111.2, wheelchair="yes")
    return RoutingService(graph)


def test_lambda_request_and_response_match_json_schemas():
    request = _request()
    request_schema = json.loads(REQUEST_SCHEMA.read_text(encoding="utf-8"))
    response_schema = json.loads(RESPONSE_SCHEMA.read_text(encoding="utf-8"))

    jsonschema.Draft202012Validator(request_schema).validate(request)
    response = handle_event({"routeKey": "POST /v1/routes", "body": json.dumps(request)}, _service())
    jsonschema.Draft202012Validator(response_schema).validate(json.loads(response["body"]))


def test_openapi_uses_components_and_existing_external_schemas():
    document = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))

    assert document["openapi"] == "3.1.0"
    assert sorted(document["paths"]) == [
        "/health",
        "/v1/events",
        "/v1/events/active",
        "/v1/events/{eventId}/resolve",
        "/v1/journeys",
        "/v1/routes",
    ]
    schemas = document["components"]["schemas"]
    assert schemas["RouteRequest"]["$ref"] == "../traversal/routing/contracts/route-request.schema.json"
    assert schemas["RouteResponse"]["$ref"] == "../traversal/routing/contracts/route-response.schema.json"
    assert REQUEST_SCHEMA.is_file()
    assert RESPONSE_SCHEMA.is_file()
