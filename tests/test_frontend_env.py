from __future__ import annotations

import pytest

from infra.scripts.render_frontend_env import render_environment, select_stack_outputs


STACK_OUTPUTS = {
    "ApiUrl": "https://api.example",
    "AwsRegion": "ap-south-1",
    "LocationMapName": "EzPathSrmCampusMap",
    "LocationSatelliteMapName": "EzPathSrmSatelliteMap",
    "OperatorUserPoolId": "ap-south-1_pool",
    "OperatorUserPoolClientId": "client-id",
    "OperatorUserPoolDomain": "https://ezpath-operators.auth.ap-south-1.amazoncognito.com",
    "AppSyncEventsHttpUrl": "https://events.example/event",
    "AppSyncEventsRealtimeUrl": "wss://events.example/event/realtime",
    "AppSyncEventsSubscriberKey": "subscriber-key",
}


def test_selects_an_explicit_stack() -> None:
    document = {"OtherStack": {}, "EzPathRoutingStack": STACK_OUTPUTS}

    assert select_stack_outputs(document, "EzPathRoutingStack") == STACK_OUTPUTS


def test_renders_a_production_vite_environment() -> None:
    rendered = render_environment(STACK_OUTPUTS, "location-key")

    assert "VITE_DEMO_MODE=false" in rendered
    assert "VITE_API_BASE_URL=https://api.example" in rendered
    assert "VITE_LOCATION_API_KEY=location-key" in rendered
    assert "VITE_APPSYNC_EVENTS_CHANNEL=/disruptions/network" in rendered


def test_rejects_incomplete_outputs() -> None:
    with pytest.raises(ValueError, match="Missing required CDK outputs"):
        render_environment({"ApiUrl": "https://api.example"}, "location-key")
