"""Read the active disruption snapshot used by the deterministic router."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from routing.evidence import FACILITY_ID, assess


ACTIVE_INDEX = "active-events"
HARD_BLOCKING_TYPES = frozenset({"elevator_outage", "path_closure", "entrance_closure"})


@dataclass(frozen=True)
class StatusSnapshot:
    active_event_ids: tuple[str, ...]
    blocking_event_ids: tuple[str, ...]
    blocked_entity_ids: frozenset[str]
    facility_assessment: dict[str, Any] | None = None
    operator_confirmation: dict[str, Any] | None = None

    def metadata(self) -> dict[str, Any]:
        return {
            "active_events": len(self.active_event_ids),
            "blocking_events": len(self.blocking_event_ids),
            "blocked_entity_ids": sorted(self.blocked_entity_ids),
            "facility_assessment": self.facility_assessment,
            "operator_confirmation": self.operator_confirmation,
        }


class DynamoStatusProvider:
    def __init__(self, table_name: str, dynamodb_resource: Any | None = None) -> None:
        if not table_name:
            raise RuntimeError("EZPATH_STATUS_TABLE is required")
        if dynamodb_resource is None:
            import boto3

            dynamodb_resource = boto3.resource("dynamodb")
        self._table = dynamodb_resource.Table(table_name)

    def get_snapshot(self) -> StatusSnapshot:
        items: list[dict[str, Any]] = []
        request: dict[str, Any] = {
            "IndexName": ACTIVE_INDEX,
            "KeyConditionExpression": "activeKey = :active",
            "ExpressionAttributeValues": {":active": "ACTIVE"},
            "ProjectionExpression": "eventId, entityId, #eventType",
            "ExpressionAttributeNames": {"#eventType": "type"},
            "ScanIndexForward": False,
        }
        while True:
            response = self._table.query(**request)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            request["ExclusiveStartKey"] = last_key

        active_ids: list[str] = []
        blocking_ids: list[str] = []
        blocked_entities: set[str] = set()
        for item in items:
            event_id = str(item.get("eventId", "")).strip()
            if event_id:
                active_ids.append(event_id)
            if item.get("type") not in HARD_BLOCKING_TYPES:
                continue
            entity_id = str(item.get("entityId", "")).strip().casefold()
            if not event_id or not entity_id:
                continue
            blocking_ids.append(event_id)
            blocked_entities.add(entity_id)
        evidence = self._table.get_item(
            Key={"pk": f"SENSOR#{FACILITY_ID}", "sk": "CURRENT"}, ConsistentRead=True,
        ).get("Item", {})
        readings = evidence.get("readings", [])
        assessment = assess(readings)
        assessment["scenario"] = evidence.get("scenario")
        confirmation_item = self._table.get_item(
            Key={"pk": f"CONFIRMATION#{FACILITY_ID}", "sk": "CURRENT"}, ConsistentRead=True,
        ).get("Item", {})
        confirmation = None
        if int(confirmation_item.get("expiresAt", 0)) > int(datetime.now(timezone.utc).timestamp()):
            confirmation = {"state": confirmation_item["state"],
                            "confirmedAt": confirmation_item["confirmedAt"],
                            "expiresAt": confirmation_item["expiresAt"]}
        return StatusSnapshot(
            active_event_ids=tuple(active_ids),
            blocking_event_ids=tuple(blocking_ids),
            blocked_entity_ids=frozenset(blocked_entities),
            facility_assessment=assessment,
            operator_confirmation=confirmation,
        )
