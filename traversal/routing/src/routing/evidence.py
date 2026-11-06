"""Deterministic quality checks for simulated facility telemetry.

The simulator is an operator training aid. Its readings never prove physical
wheelchair accessibility and never turn UNKNOWN static evidence into VERIFIED.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

FACILITY_ID = "rail-potheri"
STALE_SECONDS = 120


def assess(readings: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    valid: list[dict[str, Any]] = []
    flags: set[str] = set()
    for reading in readings:
        try:
            observed = datetime.fromisoformat(str(reading["observedAt"]).replace("Z", "+00:00"))
            if observed.tzinfo is None:
                raise ValueError("timezone required")
            age = (now - observed.astimezone(timezone.utc)).total_seconds()
            if age < -30 or age > STALE_SECONDS:
                flags.add("DELAYED_OR_MISSING")
                continue
            if (reading["state"] not in {"OPERATIONAL", "OUTAGE"}
                    or not isinstance(reading.get("sourceId"), str)
                    or not reading["sourceId"].strip()
                    or not isinstance(reading.get("sequence"), int)
                    or isinstance(reading["sequence"], bool)):
                flags.add("INVALID_READING")
                continue
            valid.append({**reading, "_time": observed.timestamp()})
        except (KeyError, TypeError, ValueError):
            flags.add("INVALID_READING")
    valid.sort(key=lambda item: item["_time"])
    if not valid:
        return {"facilityId": FACILITY_ID, "quality": "UNKNOWN", "effectiveState": "UNKNOWN",
                "flags": sorted(flags | {"MISSING_HEARTBEAT"}), "simulated": True}
    by_source: dict[str, list[dict[str, Any]]] = {}
    for reading in valid:
        by_source.setdefault(str(reading.get("sourceId", "unknown")), []).append(reading)
    latest = [items[-1] for items in by_source.values()]
    if len(latest) < 2:
        flags.add("SINGLE_SOURCE")
    elif max(item["_time"] for item in latest) - min(item["_time"] for item in latest) > 30:
        flags.add("SOURCE_LAG")
    if len({item["state"] for item in latest}) > 1:
        flags.add("SOURCE_DISAGREEMENT")
    if any(len(items) >= 3 and len({item.get("sequence") for item in items[-3:]}) == 1
           for items in by_source.values()):
        flags.add("FROZEN_SEQUENCE")
    if any(sum(a["state"] != b["state"] for a, b in zip(items[-5:], items[-5:][1:])) >= 3
           for items in by_source.values()):
        flags.add("FLUCTUATION")
    if any(len(items) >= 3 and items[-1]["state"] != items[-2]["state"]
           and items[-3]["state"] == items[-2]["state"] for items in by_source.values()):
        flags.add("SINGLE_READING_SPIKE")
    quality = "CONFLICTING" if "SOURCE_DISAGREEMENT" in flags else ("SUSPECT" if flags else "TRUSTED")
    state = latest[0]["state"] if quality == "TRUSTED" else "UNKNOWN"
    return {"facilityId": FACILITY_ID, "quality": quality, "effectiveState": state,
            "flags": sorted(flags), "simulated": True}


def decide(journeys: list[dict[str, Any]], assessment: dict[str, Any] | None,
           *, requires_lift_status: bool, confirmation: dict[str, Any] | None = None) -> dict[str, Any]:
    if not requires_lift_status or not journeys:
        return {"status": "READY", "missingFacts": []}
    affected = [journey["journey_id"] for journey in journeys if any(
        leg["mode"] == "rail" and ("potheri" in leg["from"]["name"].casefold()
                                  or "potheri" in leg["to"]["name"].casefold())
        for leg in journey["legs"])]
    if not affected:
        return {"status": "READY", "missingFacts": []}
    if confirmation and confirmation.get("state") == "OPERATIONAL":
        return {"status": "READY", "missingFacts": []}
    if confirmation and confirmation.get("state") == "OUTAGE":
        return {"status": "OPTIONS_ONLY", "missingFacts": [{"facilityId": FACILITY_ID,
            "question": "A station operator confirmed the Potheri lift is unavailable.",
            "affectedRouteIds": affected}]}
    if assessment and assessment["effectiveState"] == "OUTAGE" and assessment["quality"] == "TRUSTED":
        return {"status": "OPTIONS_ONLY", "missingFacts": [{"facilityId": FACILITY_ID,
            "question": "The Potheri lift is unavailable in this simulation. Confirm real access before travel.",
            "affectedRouteIds": affected}]}
    return {"status": "NEEDS_CONFIRMATION", "missingFacts": [{"facilityId": FACILITY_ID,
        "question": "Is the lift at Potheri operational?",
        "whyItMatters": "This journey boards or leaves suburban rail at Potheri. Simulation data cannot verify the real lift or boarding access.",
        "affectedRouteIds": affected, "whoCanConfirm": "station operator"}]}
