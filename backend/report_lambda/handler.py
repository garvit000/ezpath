"""HTTP API adapter for public report intake and operator review."""
from __future__ import annotations

import base64
from functools import lru_cache
import json
import logging
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

try:
    from .repository import DynamoReportRepository, operator_report, public_receipt
except ImportError:
    from repository import DynamoReportRepository, operator_report, public_receipt


LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)
ALLOWED_CONTENT_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_PHOTO_BYTES = 5 * 1024 * 1024
UPLOAD_EXPIRY_SECONDS = 300
ISSUE_TYPES = {"lift_outage", "path_blocked", "entrance_closed", "transit_delay", "other"}
_repository: DynamoReportRepository | None = None
_s3_client: Any | None = None


def _locations_folder() -> Path:
    handler_path = Path(__file__).resolve()
    if (handler_path.parent / "campus-locations.json").is_file():  # Lambda package
        return handler_path.parent
    return handler_path.parents[2] / "traversal" / "routing" / "config"


@lru_cache(maxsize=1)
def _campus_locations() -> dict[str, dict[str, Any]]:
    locations: dict[str, dict[str, Any]] = {}
    for name in ("campus-locations.json", "chennai-locations.json"):
        data = json.loads((_locations_folder() / name).read_text(encoding="utf-8"))
        locations.update({location["id"]: location for location in data["locations"]})
    return locations


class ReportRequestError(ValueError):
    pass


def _response(status: int, payload: Any) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(payload, separators=(",", ":"))}


def _body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body")
    if raw is None:
        raise ReportRequestError("request body is required")
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ReportRequestError("request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ReportRequestError("request body must be a JSON object")
    return value


def _text(payload: dict[str, Any], name: str, maximum: int) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ReportRequestError(f"{name} must be a non-empty string")
    value = value.strip()
    if len(value) > maximum:
        raise ReportRequestError(f"{name} must be at most {maximum} characters")
    return value


def _number(payload: dict[str, Any], name: str, minimum: float, maximum: float) -> float:
    value = payload.get(name)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < minimum or value > maximum:
        raise ReportRequestError(f"{name} is invalid")
    return float(value)


def _report_id(event: dict[str, Any]) -> str:
    value = event.get("pathParameters", {}).get("reportId")
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise ReportRequestError("reportId path parameter is required")
    return value.strip()


def _reviewer(event: dict[str, Any]) -> str:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    return str(claims.get("email") or claims.get("sub") or "cognito-operator")[:200]


def handle_event(event: dict[str, Any], repository: Any, s3_client: Any, bucket: str) -> dict[str, Any]:
    route = event.get("routeKey")
    try:
        if route == "POST /v1/reports/upload-request":
            payload = _body(event)
            content_type = _text(payload, "contentType", 64).lower()
            if content_type not in ALLOWED_CONTENT_TYPES:
                raise ReportRequestError("contentType must be image/jpeg, image/png, or image/webp")
            size = int(_number(payload, "sizeBytes", 1, MAX_PHOTO_BYTES))
            report_id = str(uuid4())
            key = f"reports/{report_id}/evidence.{ALLOWED_CONTENT_TYPES[content_type]}"
            repository.create_upload(report_id, key, content_type)
            url = s3_client.generate_presigned_url(
                "put_object",
                Params={"Bucket": bucket, "Key": key, "ContentType": content_type, "ContentLength": size},
                ExpiresIn=UPLOAD_EXPIRY_SECONDS,
            )
            return _response(201, {"reportId": report_id, "uploadUrl": url, "expiresInSeconds": UPLOAD_EXPIRY_SECONDS})
        if route == "POST /v1/reports":
            payload = _body(event)
            location_id = _text(payload, "locationId", 128)
            location = _campus_locations().get(location_id)
            if location is None:
                raise ReportRequestError("locationId must be a known Chennai or SRM location")
            issue_type = _text(payload, "issueType", 32)
            if issue_type not in ISSUE_TYPES:
                raise ReportRequestError("issueType is not supported")
            details = {
                "issueType": issue_type,
                "description": _text(payload, "description", 500),
                "locationId": location_id,
                "locationName": location["name"],
                "latitude": location["latitude"],
                "longitude": location["longitude"],
            }
            if payload.get("reportId") is None:
                return _response(201, public_receipt(repository.create_report(str(uuid4()), details)))
            report_id = _text(payload, "reportId", 64)
            key_prefix = f"reports/{report_id}/"
            objects = s3_client.list_objects_v2(Bucket=bucket, Prefix=key_prefix, MaxKeys=1).get("Contents", [])
            if not objects:
                raise ReportRequestError("photo upload was not found")
            head = s3_client.head_object(Bucket=bucket, Key=objects[0]["Key"])
            if head.get("ContentLength", 0) > MAX_PHOTO_BYTES or head.get("ContentType") not in ALLOWED_CONTENT_TYPES:
                raise ReportRequestError("uploaded photo is not valid")
            item = repository.submit(report_id, details)
            if item is None:
                return _response(409, {"error": {"code": "REPORT_NOT_OPEN", "message": "Report is missing or was already submitted"}})
            return _response(201, public_receipt(item))
        if route == "GET /v1/reports":
            reports = repository.list_pending()
            for report in reports:
                photo_key = report.pop("photoKey")
                report["photoUrl"] = photo_key and s3_client.generate_presigned_url(
                    "get_object", Params={"Bucket": bucket, "Key": photo_key}, ExpiresIn=300
                )
            return _response(200, reports)
        if route in {"POST /v1/reports/{reportId}/verify", "POST /v1/reports/{reportId}/reject"}:
            status = "VERIFIED" if route.endswith("/verify") else "REJECTED"
            item = repository.review(_report_id(event), status, _reviewer(event))
            if item is None:
                return _response(404, {"error": {"code": "REPORT_NOT_PENDING", "message": "Report was not found or is no longer pending"}})
            return _response(200, item)
        return _response(404, {"error": {"code": "ROUTE_NOT_FOUND", "message": "Unsupported API route"}})
    except (ReportRequestError, ValueError) as exc:
        return _response(400, {"error": {"code": "REPORT_REQUEST_INVALID", "message": str(exc)}})


def _dependencies() -> tuple[DynamoReportRepository, Any, str]:
    global _repository, _s3_client
    table = os.environ.get("EZPATH_REPORTS_TABLE", "")
    bucket = os.environ.get("EZPATH_REPORTS_BUCKET", "")
    if not bucket:
        raise RuntimeError("EZPATH_REPORTS_BUCKET is required")
    if _repository is None:
        _repository = DynamoReportRepository(table)
    if _s3_client is None:
        import boto3
        from botocore.config import Config

        # Browsers cannot follow the redirects the global S3 endpoint sends for new buckets.
        region = os.environ["AWS_REGION"]
        _s3_client = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=f"https://s3.{region}.amazonaws.com",
            config=Config(signature_version="s3v4"),
        )
    return _repository, _s3_client, bucket


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    LOGGER.info("report request received", extra={"aws_request_id": getattr(context, "aws_request_id", None)})
    repository, s3_client, bucket = _dependencies()
    return handle_event(event, repository, s3_client, bucket)
