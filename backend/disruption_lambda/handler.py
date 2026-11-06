"""API Gateway HTTP API adapter for live disruption events."""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from typing import Any
from uuid import uuid4

try:
    from .repository import DynamoDisruptionRepository
except ImportError:  # Lambda copies adapter modules to the task root.
    from repository import DynamoDisruptionRepository


LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

EVENT_TYPES = {
    "elevator_outage",
    "path_closure",
    "entrance_closure",
    "service_delay",
    "bus_cancellation",
}
SEVERITIES = {"critical", "warning", "info"}
_repository: DynamoDisruptionRepository | None = None


class EventRequestError(ValueError):
    """Invalid event input safe to expose as an HTTP 400 response."""


def _json_response(status_code: int, payload: Any) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload, separators=(",", ":")),
    }


def _request_body(event: dict[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body")
    if raw_body is None:
        raise EventRequestError("request body is required")
    if event.get("isBase64Encoded"):
        try:
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise EventRequestError("request body is not valid base64-encoded UTF-8") from exc
    if isinstance(raw_body, dict):
        return raw_body
    try:
        parsed = json.loads(raw_body)
    except (TypeError, json.JSONDecodeError) as exc:
        raise EventRequestError("request body must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise EventRequestError("request body must be a JSON object")
    return parsed


def _required_text(payload: dict[str, Any], name: str, maximum: int) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise EventRequestError(f"{name} must be a non-empty string")
    value = value.strip()
    if len(value) > maximum:
        raise EventRequestError(f"{name} must be at most {maximum} characters")
    return value


def _optional_text(payload: dict[str, Any], name: str, maximum: int) -> str | None:
    value = payload.get(name)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise EventRequestError(f"{name} must be a string")
    value = value.strip()
    if len(value) > maximum:
        raise EventRequestError(f"{name} must be at most {maximum} characters")
    return value or None


def _timestamp(payload: dict[str, Any], name: str, *, required: bool) -> str | None:
    value = _required_text(payload, name, 64) if required else _optional_text(payload, name, 64)
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EventRequestError(f"{name} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise EventRequestError(f"{name} must include a timezone")
    return value


def _validate_event(payload: dict[str, Any]) -> dict[str, Any]:
    if "isActive" in payload and payload["isActive"] is not True:
        raise EventRequestError("isActive must be true when creating an event")
    event_type = _required_text(payload, "type", 64)
    if event_type not in EVENT_TYPES:
        raise EventRequestError("type is not supported")
    severity = _required_text(payload, "severity", 16)
    if severity not in SEVERITIES:
        raise EventRequestError("severity must be critical, warning, or info")
    affected = payload.get("affectedLinesOrStops", [])
    if not isinstance(affected, list) or len(affected) > 50:
        raise EventRequestError("affectedLinesOrStops must be an array with at most 50 entries")
    if any(not isinstance(item, str) or not item.strip() or len(item) > 128 for item in affected):
        raise EventRequestError("affectedLinesOrStops entries must be non-empty strings up to 128 characters")

    result = {
        "id": str(uuid4()),
        "entityId": _required_text(payload, "entityId", 128),
        "entityName": _required_text(payload, "entityName", 200),
        "type": event_type,
        "severity": severity,
        "reason": _required_text(payload, "reason", 1000),
        "effectiveStart": _timestamp(payload, "effectiveStart", required=True),
        "affectedLinesOrStops": [item.strip() for item in affected],
        "impactOnAccessibility": _required_text(payload, "impactOnAccessibility", 1000),
        "isActive": True,
    }
    station = _optional_text(payload, "stationName", 200)
    resolution = _timestamp(payload, "estimatedResolution", required=False)
    if station:
        result["stationName"] = station
    if resolution:
        result["estimatedResolution"] = resolution
    return result


def _event_id(event: dict[str, Any]) -> str:
    value = event.get("pathParameters", {}).get("eventId")
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise EventRequestError("eventId path parameter is required")
    return value.strip()


SIMULATION_SCENARIOS = frozenset({
    "healthy", "outage", "missing", "delayed", "spike", "frozen", "fluctuating", "disagree",
})


def _scenario_readings(scenario: str, now: datetime) -> list[dict[str, Any]]:
    """Create repeatable training cases without accepting arbitrary sensor claims."""
    def reading(source: str, state: str, sequence: int, seconds_ago: int) -> dict[str, Any]:
        return {"sourceId": source, "state": state, "sequence": sequence,
                "observedAt": (now - timedelta(seconds=seconds_ago)).isoformat().replace("+00:00", "Z")}

    if scenario == "missing":
        return []
    if scenario == "delayed":
        return [reading("lift", "OPERATIONAL", 1, 180)]
    if scenario == "frozen":
        return [reading("lift", "OPERATIONAL", 7, ago) for ago in (30, 20, 10)]
    if scenario == "fluctuating":
        return [reading("lift", state, index, 50 - index * 10)
                for index, state in enumerate(("OPERATIONAL", "OUTAGE", "OPERATIONAL", "OUTAGE", "OPERATIONAL"))]
    if scenario == "spike":
        return [reading("lift", state, index, 30 - index * 10)
                for index, state in enumerate(("OPERATIONAL", "OPERATIONAL", "OUTAGE"))]
    if scenario == "disagree":
        return [reading("lift", "OPERATIONAL", 1, 10), reading("platform", "OUTAGE", 1, 8)]
    state = "OUTAGE" if scenario == "outage" else "OPERATIONAL"
    return [reading("lift", state, 1, 10), reading("platform", state, 1, 8)]


def handle_event(event: dict[str, Any], repository: Any) -> dict[str, Any]:
    """Handle one HTTP API event with an injected persistence repository."""
    route_key = event.get("routeKey")
    try:
        if route_key == "POST /v1/telemetry/simulate":
            payload = _request_body(event)
            if payload.get("facilityId") != "rail-potheri":
                raise EventRequestError("Only the Potheri lift simulator is available")
            scenario = _required_text(payload, "scenario", 20)
            if scenario not in SIMULATION_SCENARIOS:
                raise EventRequestError("scenario is not supported")
            return _json_response(201, repository.record_simulation(
                scenario, _scenario_readings(scenario, datetime.now(timezone.utc)),
            ))
        if route_key == "POST /v1/telemetry/confirm":
            payload = _request_body(event)
            if payload.get("facilityId") != "rail-potheri":
                raise EventRequestError("Only the Potheri lift can be confirmed")
            if payload.get("verifiedFromRealWorld") is not True:
                raise EventRequestError("Real-world verification must be acknowledged")
            state = _required_text(payload, "state", 20)
            if state not in {"OPERATIONAL", "OUTAGE"}:
                raise EventRequestError("state must be OPERATIONAL or OUTAGE")
            note = _required_text(payload, "note", 500)
            claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
            operator_id = claims.get("sub")
            if not operator_id:
                raise EventRequestError("Authenticated operator identity is required")
            return _json_response(201, repository.record_confirmation(state, note, str(operator_id)))
        if route_key == "GET /v1/events/active":
            return _json_response(200, repository.list_active())
        if route_key == "POST /v1/events":
            return _json_response(201, repository.create(_validate_event(_request_body(event))))
        if route_key == "POST /v1/events/{eventId}/resolve":
            resolved = repository.resolve(_event_id(event))
            if resolved is None:
                return _json_response(
                    404,
                    {"error": {"code": "EVENT_NOT_ACTIVE", "message": "Event was not found or is already resolved"}},
                )
            return _json_response(200, {"resolved": True, "event": resolved})
        return _json_response(
            404,
            {"error": {"code": "ROUTE_NOT_FOUND", "message": "Unsupported API route"}},
        )
    except EventRequestError as exc:
        return _json_response(
            400,
            {"error": {"code": "EVENT_REQUEST_INVALID", "message": str(exc)}},
        )


def _get_repository() -> DynamoDisruptionRepository:
    global _repository
    if _repository is None:
        _repository = DynamoDisruptionRepository(os.environ.get("EZPATH_STATUS_TABLE", ""))
    return _repository


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    request_id = getattr(context, "aws_request_id", None)
    LOGGER.info("disruption request received", extra={"aws_request_id": request_id})
    return handle_event(event, _get_repository())
