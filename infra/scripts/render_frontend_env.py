"""Render a local Vite production environment file from CDK stack outputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


OUTPUT_TO_ENV = {
    "ApiUrl": "VITE_API_BASE_URL",
    "AwsRegion": "VITE_AWS_REGION",
    "LocationMapName": "VITE_LOCATION_MAP_NAME",
    "LocationSatelliteMapName": "VITE_LOCATION_SATELLITE_MAP_NAME",
    "OperatorUserPoolId": "VITE_COGNITO_USER_POOL_ID",
    "OperatorUserPoolClientId": "VITE_COGNITO_CLIENT_ID",
    "OperatorUserPoolDomain": "VITE_COGNITO_DOMAIN",
    "AppSyncEventsHttpUrl": "VITE_APPSYNC_EVENTS_HTTP_URL",
    "AppSyncEventsRealtimeUrl": "VITE_APPSYNC_EVENTS_REALTIME_URL",
    "AppSyncEventsSubscriberKey": "VITE_APPSYNC_EVENTS_API_KEY",
}


def select_stack_outputs(document: dict[str, Any], stack_name: str | None) -> dict[str, str]:
    if stack_name:
        selected = document.get(stack_name)
        if not isinstance(selected, dict):
            raise ValueError(f"Stack {stack_name!r} was not found in the CDK outputs file")
        return {str(key): str(value) for key, value in selected.items()}

    if len(document) != 1:
        names = ", ".join(sorted(document)) or "none"
        raise ValueError(f"Expected one stack in the CDK outputs file; found: {names}")

    selected = next(iter(document.values()))
    if not isinstance(selected, dict):
        raise ValueError("The selected CDK stack output must be a JSON object")
    return {str(key): str(value) for key, value in selected.items()}


def render_environment(outputs: dict[str, str], location_api_key: str) -> str:
    missing = [key for key in OUTPUT_TO_ENV if not outputs.get(key)]
    if missing:
        raise ValueError(f"Missing required CDK outputs: {', '.join(missing)}")
    if not location_api_key.strip():
        raise ValueError("The Amazon Location browser API key value is required")

    lines = [
        "# Generated from CDK outputs. Do not commit this file.",
        "VITE_DEMO_MODE=false",
    ]
    lines.extend(
        f"{environment_name}={outputs[output_name]}"
        for output_name, environment_name in OUTPUT_TO_ENV.items()
    )
    lines.extend(
        [
            f"VITE_LOCATION_API_KEY={location_api_key.strip()}",
            "VITE_APPSYNC_EVENTS_CHANNEL=/disruptions/network",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outputs", type=Path, required=True, help="CDK --outputs-file JSON")
    parser.add_argument("--stack", help="Stack key in the CDK outputs JSON")
    parser.add_argument(
        "--location-api-key",
        required=True,
        help="Browser API key returned by aws location describe-key",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".env.production"),
        help="Destination Vite env file (default: .env.production)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    document = json.loads(args.outputs.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("The CDK outputs file must contain a JSON object")
    outputs = select_stack_outputs(document, args.stack)
    content = render_environment(outputs, args.location_api_key)
    args.output.write_text(content, encoding="utf-8")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
