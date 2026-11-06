from datetime import datetime, timezone

import pytest

from routing.evidence import assess, decide
from backend.disruption_lambda.handler import _scenario_readings


NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("scenario, quality, state, flag", [
    ("healthy", "TRUSTED", "OPERATIONAL", None),
    ("outage", "TRUSTED", "OUTAGE", None),
    ("missing", "UNKNOWN", "UNKNOWN", "MISSING_HEARTBEAT"),
    ("delayed", "UNKNOWN", "UNKNOWN", "DELAYED_OR_MISSING"),
    ("spike", "SUSPECT", "UNKNOWN", "SINGLE_READING_SPIKE"),
    ("frozen", "SUSPECT", "UNKNOWN", "FROZEN_SEQUENCE"),
    ("fluctuating", "SUSPECT", "UNKNOWN", "FLUCTUATION"),
    ("disagree", "CONFLICTING", "UNKNOWN", "SOURCE_DISAGREEMENT"),
])
def test_simulation_quality(scenario, quality, state, flag):
    result = assess(_scenario_readings(scenario, NOW), now=NOW)

    assert result["quality"] == quality
    assert result["effectiveState"] == state
    assert flag is None or flag in result["flags"]


def test_single_source_is_not_trusted():
    result = assess(_scenario_readings("healthy", NOW)[:1], now=NOW)
    assert result["quality"] == "SUSPECT"
    assert "SINGLE_SOURCE" in result["flags"]


POTHERI_JOURNEY = {"journey_id": "potheri", "legs": [
    {"mode": "rail", "from": {"name": "Potheri"}, "to": {"name": "Tambaram"}},
]}
OTHER_JOURNEY = {"journey_id": "metro", "legs": [
    {"mode": "metro", "from": {"name": "Airport"}, "to": {"name": "Guindy"}},
]}


def test_lift_dependent_potheri_route_waits_for_real_confirmation():
    assessment = assess(_scenario_readings("healthy", NOW), now=NOW)
    decision = decide([POTHERI_JOURNEY, OTHER_JOURNEY], assessment, requires_lift_status=True)

    assert decision["status"] == "NEEDS_CONFIRMATION"
    assert decision["missingFacts"][0]["affectedRouteIds"] == ["potheri"]
    assert "simulation" in decision["missingFacts"][0]["whyItMatters"].lower()
    assert decide([POTHERI_JOURNEY], None, requires_lift_status=True)["status"] == "NEEDS_CONFIRMATION"


def test_trusted_simulated_outage_suppresses_potheri_recommendation():
    assessment = assess(_scenario_readings("outage", NOW), now=NOW)
    decision = decide([POTHERI_JOURNEY], assessment, requires_lift_status=True)
    assert decision["status"] == "OPTIONS_ONLY"


def test_real_operator_confirmation_resolves_exact_missing_fact():
    uncertain = assess(_scenario_readings("disagree", NOW), now=NOW)
    ready = decide([POTHERI_JOURNEY], uncertain, requires_lift_status=True,
                   confirmation={"state": "OPERATIONAL"})
    closed = decide([POTHERI_JOURNEY], uncertain, requires_lift_status=True,
                    confirmation={"state": "OUTAGE"})
    assert ready["status"] == "READY"
    assert closed["status"] == "OPTIONS_ONLY"


def test_unaffected_or_non_lift_dependent_routes_remain_available():
    assert decide([OTHER_JOURNEY], None, requires_lift_status=True)["status"] == "READY"
    assert decide([POTHERI_JOURNEY], None, requires_lift_status=False)["status"] == "READY"
