from decimal import Decimal
import json
from pathlib import Path
import shutil
import subprocess
import sys

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from backend.report_lambda.handler import handle_event
from backend.report_lambda.repository import DynamoReportRepository


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class DynamoTypedTable:
    """In-memory table that applies the boto3 resource's number rules."""

    def __init__(self):
        self.items = {}

    @staticmethod
    def _stored(values):
        serializer = TypeSerializer()
        deserializer = TypeDeserializer()
        return {key: deserializer.deserialize(serializer.serialize(value)) for key, value in values.items()}

    def put_item(self, Item, **_):
        stored = self._stored(Item)
        self.items[stored["reportId"]] = stored

    def update_item(self, Key, ExpressionAttributeValues, **_):
        values = self._stored(ExpressionAttributeValues)
        item = self.items[Key["reportId"]]
        if ":description" in values:
            item.update(
                status=values[":pending"],
                statusKey=values[":pending"],
                submittedAt=values[":now"],
                description=values[":description"],
                locationId=values[":locationId"],
                locationName=values[":locationName"],
                issueType=values[":issueType"],
                latitude=values[":latitude"],
                longitude=values[":longitude"],
            )
        else:
            item.update(status=values[":status"], reviewedAt=values[":now"], reviewedBy=values[":reviewer"])
            item.pop("statusKey")
        return {"Attributes": dict(item)}

    def query(self, **_):
        return {"Items": [dict(item) for item in self.items.values() if "statusKey" in item]}


class DynamoResource:
    def __init__(self, table):
        self.table = table

    def Table(self, _name):
        return self.table


class FakeRepository:
    def __init__(self):
        self.created = None
        self.submitted = None
        self.reviewed = None

    def create_upload(self, report_id, photo_key, content_type):
        self.created = (report_id, photo_key, content_type)

    def submit(self, report_id, details):
        self.submitted = (report_id, details)
        return {
            "reportId": report_id,
            "status": "PENDING_REVIEW",
            "createdAt": "2026-11-06T00:00:00Z",
            "submittedAt": "2026-11-06T00:01:00Z",
        }

    def list_pending(self):
        return [{
            "reportId": "report-1",
            "status": "PENDING_REVIEW",
            "photoKey": "reports/report-1/evidence.jpg",
        }]

    def review(self, report_id, status, reviewer):
        self.reviewed = (report_id, status, reviewer)
        return {"reportId": report_id, "status": status}


class FakeS3:
    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://signed.example/{operation}/{Params['Key']}"

    def list_objects_v2(self, **kwargs):
        return {"Contents": [{"Key": f"{kwargs['Prefix']}evidence.jpg"}]}

    def head_object(self, **kwargs):
        return {"ContentLength": 1234, "ContentType": "image/jpeg"}


def response_body(response):
    return json.loads(response["body"])


def test_public_upload_and_submission_flow():
    repository = FakeRepository()
    s3 = FakeS3()
    upload = handle_event(
        {"routeKey": "POST /v1/reports/upload-request", "body": json.dumps({"contentType": "image/jpeg", "sizeBytes": 1234})},
        repository,
        s3,
        "private-bucket",
    )
    assert upload["statusCode"] == 201
    report_id = response_body(upload)["reportId"]
    assert repository.created[0] == report_id

    submitted = handle_event(
        {
            "routeKey": "POST /v1/reports",
            "body": json.dumps({
                "reportId": report_id,
                "issueType": "lift_outage",
                "description": "Lift is not responding near the entrance.",
                "locationId": "srm-library",
            }),
        },
        repository,
        s3,
        "private-bucket",
    )
    assert submitted["statusCode"] == 201
    assert response_body(submitted)["status"] == "PENDING_REVIEW"
    assert repository.submitted[1]["locationName"] == "SRM Library"


def test_operator_list_uses_short_lived_photo_url_and_review_identity():
    repository = FakeRepository()
    s3 = FakeS3()
    listed = handle_event({"routeKey": "GET /v1/reports"}, repository, s3, "private-bucket")
    assert response_body(listed)[0]["photoUrl"].startswith("https://signed.example/get_object/")
    assert "photoKey" not in response_body(listed)[0]

    reviewed = handle_event(
        {
            "routeKey": "POST /v1/reports/{reportId}/verify",
            "pathParameters": {"reportId": "report-1"},
            "requestContext": {"authorizer": {"jwt": {"claims": {"email": "operator@example.com"}}}},
        },
        repository,
        s3,
        "private-bucket",
    )
    assert reviewed["statusCode"] == 200
    assert repository.reviewed == ("report-1", "VERIFIED", "operator@example.com")


def test_rejects_unsupported_or_oversized_photos():
    repository = FakeRepository()
    s3 = FakeS3()
    wrong_type = handle_event(
        {"routeKey": "POST /v1/reports/upload-request", "body": json.dumps({"contentType": "image/gif", "sizeBytes": 100})},
        repository,
        s3,
        "private-bucket",
    )
    assert wrong_type["statusCode"] == 400

    too_large = handle_event(
        {"routeKey": "POST /v1/reports/upload-request", "body": json.dumps({"contentType": "image/jpeg", "sizeBytes": 6 * 1024 * 1024})},
        repository,
        s3,
        "private-bucket",
    )
    assert too_large["statusCode"] == 400


def test_real_repository_handles_dynamodb_number_types_through_review():
    table = DynamoTypedTable()
    repository = DynamoReportRepository("reports", DynamoResource(table))
    s3 = FakeS3()
    upload = handle_event(
        {"routeKey": "POST /v1/reports/upload-request", "body": json.dumps({"contentType": "image/jpeg", "sizeBytes": 1234})},
        repository,
        s3,
        "private-bucket",
    )
    report_id = response_body(upload)["reportId"]

    submitted = handle_event(
        {
            "routeKey": "POST /v1/reports",
            "body": json.dumps({
                "reportId": report_id,
                "issueType": "lift_outage",
                "description": "Lift is not responding near the entrance.",
                "locationId": "srm-library",
            }),
        },
        repository,
        s3,
        "private-bucket",
    )
    assert submitted["statusCode"] == 201
    assert isinstance(table.items[report_id]["latitude"], Decimal)

    listed = handle_event({"routeKey": "GET /v1/reports"}, repository, s3, "private-bucket")
    assert listed["statusCode"] == 200
    assert response_body(listed)[0]["latitude"] == 12.8232845
    assert response_body(listed)[0]["longitude"] == 80.0425857

    reviewed = handle_event(
        {
            "routeKey": "POST /v1/reports/{reportId}/verify",
            "pathParameters": {"reportId": report_id},
            "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "operator-1"}}}},
        },
        repository,
        s3,
        "private-bucket",
    )
    assert reviewed["statusCode"] == 200
    assert response_body(reviewed)["status"] == "VERIFIED"
    assert response_body(reviewed)["latitude"] == 12.8232845


def test_traveller_can_report_an_outage_without_a_photo():
    table = DynamoTypedTable()
    repository = DynamoReportRepository("reports", DynamoResource(table))
    s3 = FakeS3()

    submitted = handle_event(
        {
            "routeKey": "POST /v1/reports",
            "body": json.dumps({
                "issueType": "path_blocked",
                "description": "The ramp at the east exit is blocked by barricades.",
                "locationId": "rail-potheri",
            }),
        },
        repository,
        s3,
        "private-bucket",
    )
    assert submitted["statusCode"] == 201

    listed = response_body(handle_event({"routeKey": "GET /v1/reports"}, repository, s3, "private-bucket"))
    assert listed[0]["issueType"] == "path_blocked"
    assert listed[0]["locationName"] == "Potheri"
    assert listed[0]["photoUrl"] is None


def test_rejects_unknown_issue_types_and_locations():
    repository = DynamoReportRepository("reports", DynamoResource(DynamoTypedTable()))
    for payload in (
        {"issueType": "aliens", "description": "Something unusual", "locationId": "srm-library"},
        {"issueType": "other", "description": "Something unusual", "locationId": "nowhere"},
    ):
        response = handle_event({"routeKey": "POST /v1/reports", "body": json.dumps(payload)}, repository, FakeS3(), "b")
        assert response["statusCode"] == 400


def test_handler_finds_locations_in_the_lambda_package_layout(tmp_path):
    source = REPOSITORY_ROOT / "backend" / "report_lambda"
    shutil.copy2(source / "handler.py", tmp_path / "handler.py")
    shutil.copy2(source / "repository.py", tmp_path / "repository.py")
    for name in ("campus-locations.json", "chennai-locations.json"):
        shutil.copy2(REPOSITORY_ROOT / "traversal" / "routing" / "config" / name, tmp_path / name)

    result = subprocess.run(
        [sys.executable, "-B", "-c", "import handler; print(handler._campus_locations()['srm-library']['name'])"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout.strip() == "SRM Library"


