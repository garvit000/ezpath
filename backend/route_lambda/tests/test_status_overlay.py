from datetime import datetime, timedelta, timezone

from backend.route_lambda.status_overlay import DynamoStatusProvider


class FakeTable:
    def __init__(self, responses, items=None):
        self.responses = list(responses)
        self.requests = []
        self.items = items or {}

    def query(self, **request):
        self.requests.append(request)
        return self.responses.pop(0)

    def get_item(self, **request):
        self.get_request = request
        return {"Item": self.items.get(request["Key"]["pk"], {})}


class FakeDynamo:
    def __init__(self, table):
        self.table = table

    def Table(self, name):
        self.table_name = name
        return self.table


def test_status_snapshot_paginates_and_only_hard_blocks_closures():
    table = FakeTable(
        [
            {
                "Items": [
                    {"eventId": "event-1", "entityId": "LIFT-A1", "type": "elevator_outage"},
                    {"eventId": "event-2", "entityId": "line-blue", "type": "service_delay"},
                ],
                "LastEvaluatedKey": {"pk": "EVENT#event-2", "sk": "EVENT"},
            },
            {
                "Items": [
                    {"eventId": "event-3", "entityId": "path-7", "type": "path_closure"},
                ]
            },
        ]
    )
    dynamo = FakeDynamo(table)

    snapshot = DynamoStatusProvider("status-table", dynamo).get_snapshot()

    assert dynamo.table_name == "status-table"
    assert snapshot.active_event_ids == ("event-1", "event-2", "event-3")
    assert snapshot.blocking_event_ids == ("event-1", "event-3")
    assert snapshot.blocked_entity_ids == frozenset({"lift-a1", "path-7"})
    assert table.requests[0]["IndexName"] == "active-events"
    assert table.requests[1]["ExclusiveStartKey"]["pk"] == "EVENT#event-2"
    assert table.get_request["ConsistentRead"] is True
    assert snapshot.facility_assessment["quality"] == "UNKNOWN"


def test_status_snapshot_ignores_incomplete_blocking_records():
    table = FakeTable(
        [{"Items": [{"eventId": "event-1", "entityId": "", "type": "entrance_closure"}]}]
    )

    snapshot = DynamoStatusProvider("status-table", FakeDynamo(table)).get_snapshot()

    assert snapshot.active_event_ids == ("event-1",)
    assert snapshot.blocking_event_ids == ()
    assert snapshot.blocked_entity_ids == frozenset()


def test_expired_operator_confirmation_is_not_used():
    now = datetime.now(timezone.utc)
    expired = {"state": "OPERATIONAL", "confirmedAt": now.isoformat(),
               "expiresAt": int((now - timedelta(seconds=1)).timestamp())}
    current = {**expired, "expiresAt": int((now + timedelta(minutes=5)).timestamp())}
    table = FakeTable([{"Items": []}], {"CONFIRMATION#rail-potheri": expired})
    assert DynamoStatusProvider("status-table", FakeDynamo(table)).get_snapshot().operator_confirmation is None
    table = FakeTable([{"Items": []}], {"CONFIRMATION#rail-potheri": current})
    assert DynamoStatusProvider("status-table", FakeDynamo(table)).get_snapshot().operator_confirmation["state"] == "OPERATIONAL"
