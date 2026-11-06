"""AWS Lambda adapter for the framework-independent routing service.

The routing algorithm remains unaware of AWS. This module only translates an
API Gateway HTTP API event into the canonical JSON contract and maps expected
domain errors to HTTP responses.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

from routing.catalog import expand_blocked
from routing.graph import load_graph
from routing.journeys import JourneyPlanner
from routing.service import RouteRequestError, RoutingService
from routing.street_paths import StreetWalker
from routing.transit import TransitNetwork

try:
    from .graph_artifact import (
        ensure_graph_artifact,
        graph_settings_from_environment,
        transit_settings_from_environment,
    )
    from .status_overlay import DynamoStatusProvider
except ImportError:  # Lambda copies the adapter modules to the task root.
    from graph_artifact import (
        ensure_graph_artifact,
        graph_settings_from_environment,
        transit_settings_from_environment,
    )
    from status_overlay import DynamoStatusProvider


LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

JOURNEYS_ROUTE = "POST /v1/journeys"

_service: RoutingService | None = None
_status_provider: DynamoStatusProvider | None = None
_planner: JourneyPlanner | None = None


def _json_response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload, separators=(",", ":")),
    }


def _request_body(event: dict[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body")
    if raw_body is None:
        raise RouteRequestError("request body is required")
    if event.get("isBase64Encoded"):
        try:
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise RouteRequestError("request body is not valid base64-encoded UTF-8") from exc
    if isinstance(raw_body, dict):
        return raw_body
    try:
        parsed = json.loads(raw_body)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RouteRequestError("request body must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise RouteRequestError("request body must be a JSON object")
    return parsed


def _get_service() -> RoutingService:
    global _service
    if _service is None:
        local_path, bucket, key = graph_settings_from_environment()
        graph_path = ensure_graph_artifact(local_path, bucket=bucket, key=key)
        LOGGER.info("loading routing graph", extra={"graph_path": graph_path})
        _service = RoutingService(load_graph(graph_path))
    return _service


def _get_planner(service: RoutingService) -> JourneyPlanner | None:
    global _planner
    if _planner is None:
        try:
            local_path, bucket, key = transit_settings_from_environment()
            path = ensure_graph_artifact(local_path, bucket=bucket, key=key)
            calculator = os.environ.get("EZPATH_ROUTE_CALCULATOR")
            _planner = JourneyPlanner(
                TransitNetwork.load(path), service.graph, service.graph_version,
                StreetWalker(calculator) if calculator else None,
            )
        except Exception:
            LOGGER.exception("transit artifact unavailable")
    return _planner


def handle_event(
    event: dict[str, Any],
    service: RoutingService,
    status_provider: Any | None = None,
    planner: JourneyPlanner | None = None,
) -> dict[str, Any]:
    """Handle one API Gateway event with injected routing services."""
    if event.get("routeKey") == "GET /health":
        return _json_response(
            200,
            {
                "status": "ok",
                "graph_version": service.graph_version,
                "nodes": service.graph.number_of_nodes(),
                "edges": service.graph.number_of_edges(),
            },
        )
    try:
        if status_provider is None:
            blocked_entity_ids = frozenset()
            overlay = None
        else:
            try:
                snapshot = status_provider.get_snapshot()
            except Exception:
                LOGGER.exception("active disruption snapshot unavailable")
                return _json_response(
                    503,
                    {
                        "error": {
                            "code": "STATUS_OVERLAY_UNAVAILABLE",
                            "message": "Live accessibility status is temporarily unavailable",
                        }
                    },
                )
            blocked_entity_ids = snapshot.blocked_entity_ids
            overlay = snapshot.metadata()
        if event.get("routeKey") == "GET /v1/telemetry/evidence":
            from routing.evidence import assess
            return _json_response(200, {**((overlay or {}).get("facility_assessment") or assess([])),
                                        "operatorConfirmation": (overlay or {}).get("operator_confirmation")})
        payload = _request_body(event)
        if event.get("routeKey") == JOURNEYS_ROUTE:
            if planner is None:
                return _json_response(
                    503,
                    {
                        "error": {
                            "code": "TRANSIT_DATA_UNAVAILABLE",
                            "message": "Chennai transit data is temporarily unavailable",
                        }
                    },
                )
            return _json_response(
                200,
                planner.plan(payload, blocked_entity_ids=blocked_entity_ids, status_overlay=overlay),
            )
        result = service.route(
            payload,
            blocked_entity_ids=expand_blocked(blocked_entity_ids, service.graph),
            status_overlay=overlay,
        )
        return _json_response(200, result)
    except RouteRequestError as exc:
        message = str(exc)
        status_code = 422 if "SNAP_DISTANCE_EXCEEDED" in message else 400
        return _json_response(
            status_code,
            {
                "error": {
                    "code": "ROUTE_REQUEST_INVALID",
                    "message": message,
                }
            },
        )


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """AWS Lambda entry point."""
    request_id = getattr(context, "aws_request_id", None)
    LOGGER.info("route request received", extra={"aws_request_id": request_id})
    service = _get_service()
    planner = _get_planner(service) if event.get("routeKey") == JOURNEYS_ROUTE else None
    return handle_event(event, service, _get_status_provider(), planner)


def _get_status_provider() -> DynamoStatusProvider:
    global _status_provider
    if _status_provider is None:
        _status_provider = DynamoStatusProvider(os.environ.get("EZPATH_STATUS_TABLE", ""))
    return _status_provider
