"""DynamoDB persistence for community accessibility reports."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any


PENDING_STATUS = "PENDING_REVIEW"
REPORT_RETENTION_DAYS = 90


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _stored_coordinate(value: float) -> Decimal:
    """DynamoDB rejects floats, so store the exact decimal text of the coordinate."""
    return Decimal(str(value))


def _response_coordinate(value: Decimal | None) -> float | None:
    """DynamoDB returns Decimal, which the JSON response cannot serialize."""
    return None if value is None else float(value)


def public_receipt(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "reportId": item["reportId"],
        "status": item["status"],
        "submittedAt": item.get("submittedAt", item["createdAt"]),
    }


def operator_report(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "reportId": item["reportId"],
        "status": item["status"],
        "issueType": item.get("issueType", "other"),
        "description": item.get("description", ""),
        "locationId": item.get("locationId", ""),
        "locationName": item.get("locationName", ""),
        "latitude": _response_coordinate(item.get("latitude")),
        "longitude": _response_coordinate(item.get("longitude")),
        "photoKey": item.get("photoKey"),
        "contentType": item.get("contentType"),
        "createdAt": item["createdAt"],
        "submittedAt": item.get("submittedAt"),
        "reviewedAt": item.get("reviewedAt"),
        "reviewedBy": item.get("reviewedBy"),
    }


class DynamoReportRepository:
    def __init__(self, table_name: str, dynamodb_resource: Any | None = None) -> None:
        if not table_name:
            raise RuntimeError("EZPATH_REPORTS_TABLE is required")
        if dynamodb_resource is None:
            import boto3

            dynamodb_resource = boto3.resource("dynamodb")
        self._table = dynamodb_resource.Table(table_name)

    def create_upload(self, report_id: str, photo_key: str, content_type: str) -> dict[str, Any]:
        now = _now()
        item = {
            "reportId": report_id,
            "status": "AWAITING_UPLOAD",
            "photoKey": photo_key,
            "contentType": content_type,
            "createdAt": _iso(now),
            "expiresAt": int((now + timedelta(days=REPORT_RETENTION_DAYS)).timestamp()),
        }
        self._table.put_item(Item=item, ConditionExpression="attribute_not_exists(reportId)")
        return item

    def create_report(self, report_id: str, details: dict[str, Any]) -> dict[str, Any]:
        """Store a report that has no photo."""
        now = _now()
        item = {
            **details,
            "reportId": report_id,
            "status": PENDING_STATUS,
            "statusKey": PENDING_STATUS,
            "latitude": _stored_coordinate(details["latitude"]),
            "longitude": _stored_coordinate(details["longitude"]),
            "createdAt": _iso(now),
            "submittedAt": _iso(now),
            "expiresAt": int((now + timedelta(days=REPORT_RETENTION_DAYS)).timestamp()),
        }
        self._table.put_item(Item=item, ConditionExpression="attribute_not_exists(reportId)")
        return item

    def submit(self, report_id: str, details: dict[str, Any]) -> dict[str, Any] | None:
        now = _now()
        try:
            response = self._table.update_item(
                Key={"reportId": report_id},
                UpdateExpression=(
                    "SET #status = :pending, statusKey = :pending, submittedAt = :now, "
                    "issueType = :issueType, description = :description, locationId = :locationId, locationName = :locationName, "
                    "latitude = :latitude, longitude = :longitude"
                ),
                ConditionExpression="attribute_exists(reportId) AND #status = :awaiting",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":pending": PENDING_STATUS,
                    ":awaiting": "AWAITING_UPLOAD",
                    ":now": _iso(now),
                    ":issueType": details["issueType"],
                    ":description": details["description"],
                    ":locationId": details["locationId"],
                    ":locationName": details["locationName"],
                    ":latitude": _stored_coordinate(details["latitude"]),
                    ":longitude": _stored_coordinate(details["longitude"]),
                },
                ReturnValues="ALL_NEW",
            )
        except Exception as exc:
            if getattr(exc, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None
            raise
        return response["Attributes"]

    def list_pending(self) -> list[dict[str, Any]]:
        response = self._table.query(
            IndexName="reports-by-status",
            KeyConditionExpression="statusKey = :pending",
            ExpressionAttributeValues={":pending": PENDING_STATUS},
            ScanIndexForward=False,
            Limit=50,
        )
        return [operator_report(item) for item in response.get("Items", [])]

    def review(self, report_id: str, status: str, reviewer: str) -> dict[str, Any] | None:
        now = _now()
        try:
            response = self._table.update_item(
                Key={"reportId": report_id},
                UpdateExpression="SET #status = :status, reviewedAt = :now, reviewedBy = :reviewer REMOVE statusKey",
                ConditionExpression="#status = :pending",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": status,
                    ":pending": PENDING_STATUS,
                    ":now": _iso(now),
                    ":reviewer": reviewer,
                },
                ReturnValues="ALL_NEW",
            )
        except Exception as exc:
            if getattr(exc, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None
            raise
        return operator_report(response["Attributes"])
