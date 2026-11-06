import json

from backend.disruption_lambda.handler import handle_event


VALID_EVENT = {
    "entityId": "lift-a1",
    "entityName": "Elevator A1",
    "stationName": "Central Station",
    "type": "elevator_outage",
    "severity": "critical",
    "reason": "Elevator telemetry reports an outage",
    "effectiveStart": "2026-11-06T10:00:00+05:30",
    "estimatedResolution": "2026-11-06T12:00:00+05:30",
    "affectedLinesOrStops": ["Blue Line"],
    "impactOnAccessibility": "Step-free interchange is unavailable",
}


class FakeRepository:
    def __init__(self) -> None:
        self.events = {}

    def create(self, event):
        self.events[event["id"]] = event
        return event

    def list_active(self):
        return [event for event in self.events.values() if event["isActive"]]

    def resolve(self, event_id):
        event = self.events.get(event_id)
        if not event or not event["isActive"]:
            return None
        event["isActive"] = False
        return event

    def record_simulation(self, scenario, readings):
        self.simulation = (scenario, readings)
        return {"facilityId": "rail-potheri", "scenario": scenario}

    def record_confirmation(self, state, note, operator_id):
        self.confirmation = (state, note, operator_id)
        return {"facilityId": "rail-potheri", "state": state}


def _post(route_key, payload, path_parameters=None):
    return {
        "version": "2.0",
        "routeKey": route_key,
        "body": json.dumps(payload),
        "pathParameters": path_parameters or {},
    }


def test_create_list_and_resolve_event():
    repository = FakeRepository()
    created_response = handle_event(_post("POST /v1/events", VALID_EVENT), repository)

    assert created_response["statusCode"] == 201
    created = json.loads(created_response["body"])
    assert created["isActive"] is True
    assert created["entityId"] == "lift-a1"

    active_response = handle_event({"routeKey": "GET /v1/events/active"}, repository)
    assert json.loads(active_response["body"]) == [created]

    resolved_response = handle_event(
        {
            "routeKey": "POST /v1/events/{eventId}/resolve",
            "pathParameters": {"eventId": created["id"]},
        },
        repository,
    )
    assert resolved_response["statusCode"] == 200
    assert json.loads(resolved_response["body"])["event"]["isActive"] is False
    assert json.loads(handle_event({"routeKey": "GET /v1/events/active"}, repository)["body"]) == []


def test_operator_simulation_accepts_only_bounded_scenarios():
    repository = FakeRepository()
    response = handle_event(_post("POST /v1/telemetry/simulate", {
        "facilityId": "rail-potheri", "scenario": "disagree",
    }), repository)
    assert response["statusCode"] == 201
    assert repository.simulation[0] == "disagree"
    assert len(repository.simulation[1]) == 2

    rejected = handle_event(_post("POST /v1/telemetry/simulate", {
        "facilityId": "rail-potheri", "scenario": "arbitrary",
    }), repository)
    assert rejected["statusCode"] == 400
    assert repository.simulation[0] == "disagree"


def test_real_world_confirmation_requires_operator_identity_and_acknowledgement():
    repository = FakeRepository()
    payload = {"facilityId": "rail-potheri", "state": "OPERATIONAL",
               "note": "Confirmed with station staff", "verifiedFromRealWorld": True}
    request = _post("POST /v1/telemetry/confirm", payload)
    assert handle_event(request, repository)["statusCode"] == 400
    request["requestContext"] = {"authorizer": {"jwt": {"claims": {"sub": "operator-1"}}}}
    assert handle_event(request, repository)["statusCode"] == 201
    assert repository.confirmation == ("OPERATIONAL", "Confirmed with station staff", "operator-1")
    request["body"] = json.dumps({**payload, "verifiedFromRealWorld": False})
    assert handle_event(request, repository)["statusCode"] == 400


def test_rejects_invalid_event_without_writing():
    repository = FakeRepository()
    invalid = {**VALID_EVENT, "severity": "urgent"}

    response = handle_event(_post("POST /v1/events", invalid), repository)

    assert response["statusCode"] == 400
    assert json.loads(response["body"])["error"]["code"] == "EVENT_REQUEST_INVALID"
    assert repository.events == {}


def test_rejects_timestamp_without_timezone():
    repository = FakeRepository()
    invalid = {**VALID_EVENT, "effectiveStart": "2026-11-06T10:00:00"}

    response = handle_event(_post("POST /v1/events", invalid), repository)

    assert response["statusCode"] == 400
    assert "timezone" in json.loads(response["body"])["error"]["message"]


def test_resolving_missing_event_returns_404():
    response = handle_event(
        {
            "routeKey": "POST /v1/events/{eventId}/resolve",
            "pathParameters": {"eventId": "missing"},
        },
        FakeRepository(),
    )

    assert response["statusCode"] == 404
