"""DynamoDB persistence boundary for live disruption events."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


ACTIVE_INDEX = "active-events"
ACTIVE_KEY = "ACTIVE"
RESOLVED_RETENTION_DAYS = 30


def _event_from_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["eventId"],
        "entityId": item["entityId"],
        "entityName": item["entityName"],
        **({"stationName": item["stationName"]} if item.get("stationName") else {}),
        "type": item["type"],
        "severity": item["severity"],
        "reason": item["reason"],
        "effectiveStart": item["effectiveStart"],
        **(
            {"estimatedResolution": item["estimatedResolution"]}
            if item.get("estimatedResolution")
            else {}
        ),
        "affectedLinesOrStops": item.get("affectedLinesOrStops", []),
        "impactOnAccessibility": item["impactOnAccessibility"],
        "isActive": item.get("status") == ACTIVE_KEY,
    }


class DynamoDisruptionRepository:
    """Store disruptions using a sparse GSI for efficient active-event reads."""

    def __init__(self, table_name: str, dynamodb_resource: Any | None = None) -> None:
        if not table_name:
            raise RuntimeError("EZPATH_STATUS_TABLE is required")
        if dynamodb_resource is None:
            import boto3

            dynamodb_resource = boto3.resource("dynamodb")
        self._table = dynamodb_resource.Table(table_name)

    def create(self, event: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        item = {
            "pk": f"EVENT#{event['id']}",
            "sk": "EVENT",
            "entityType": "DISRUPTION",
            "eventId": event["id"],
            "entityId": event["entityId"],
            "entityName": event["entityName"],
            "type": event["type"],
            "severity": event["severity"],
            "reason": event["reason"],
            "effectiveStart": event["effectiveStart"],
            "affectedLinesOrStops": event["affectedLinesOrStops"],
            "impactOnAccessibility": event["impactOnAccessibility"],
            "status": ACTIVE_KEY,
            "activeKey": ACTIVE_KEY,
            "createdAt": now,
            "updatedAt": now,
        }
        for optional in ("stationName", "estimatedResolution"):
            if event.get(optional):
                item[optional] = event[optional]
        self._table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
        return _event_from_item(item)

    def record_simulation(self, scenario: str, readings: list[dict[str, Any]]) -> dict[str, Any]:
        """Replace the training snapshot atomically; never create a live disruption."""
        now = datetime.now(timezone.utc)
        item = {
            "pk": "SENSOR#rail-potheri", "sk": "CURRENT", "scenario": scenario,
            "readings": readings, "simulatedAt": now.isoformat().replace("+00:00", "Z"),
            "expiresAt": int(now.timestamp()) + 3600,
        }
        self._table.put_item(Item=item)
        return {"facilityId": "rail-potheri", "scenario": scenario, "simulatedAt": item["simulatedAt"]}

    def record_confirmation(self, state: str, note: str, operator_id: str) -> dict[str, Any]:
        """Store a time-limited manual attestation separately from simulator readings."""
        now = datetime.now(timezone.utc)
        item = {
            "pk": "CONFIRMATION#rail-potheri", "sk": "CURRENT", "state": state,
            "note": note, "operatorId": operator_id,
            "confirmedAt": now.isoformat().replace("+00:00", "Z"),
            "expiresAt": int((now + timedelta(minutes=15)).timestamp()),
        }
        self._table.put_item(Item=item)
        return {"facilityId": "rail-potheri", "state": state,
                "confirmedAt": item["confirmedAt"], "expiresAt": item["expiresAt"]}

    def list_active(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        request: dict[str, Any] = {
            "IndexName": ACTIVE_INDEX,
            "KeyConditionExpression": "activeKey = :active",
            "ExpressionAttributeValues": {":active": ACTIVE_KEY},
            "ScanIndexForward": False,
        }
        while True:
            response = self._table.query(**request)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            request["ExclusiveStartKey"] = last_key
        return [_event_from_item(item) for item in items]

    def resolve(self, event_id: str) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        try:
            response = self._table.update_item(
                Key={"pk": f"EVENT#{event_id}", "sk": "EVENT"},
                UpdateExpression=(
                    "SET #status = :resolved, updatedAt = :now, resolvedAt = :now, "
                    "expiresAt = :expires REMOVE activeKey"
                ),
                ConditionExpression="attribute_exists(pk) AND activeKey = :active",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":resolved": "RESOLVED",
                    ":active": ACTIVE_KEY,
                    ":now": now.isoformat().replace("+00:00", "Z"),
                    ":expires": int((now + timedelta(days=RESOLVED_RETENTION_DAYS)).timestamp()),
                },
                ReturnValues="ALL_NEW",
            )
        except Exception as exc:
            error = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if error == "ConditionalCheckFailedException":
                return None
            raise
        return _event_from_item(response["Attributes"])
