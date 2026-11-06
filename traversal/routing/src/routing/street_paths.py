"""Street walking paths from Amazon Location for areas outside the campus graph."""
from __future__ import annotations

from typing import Any


class StreetWalker:
    """Ask a route calculator for walking paths. Failures fall back to estimates."""

    def __init__(self, calculator_name: str, client: Any | None = None) -> None:
        self.calculator_name = calculator_name
        self._client = client
        self._cache: dict[tuple[float, float, float, float], tuple[float, list[list[float]]] | None] = {}

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client("location", config=Config(
                connect_timeout=2, read_timeout=3, retries={"max_attempts": 1},
            ))
        return self._client

    def path(self, start: tuple[float, float], end: tuple[float, float]) -> tuple[float, list[list[float]]] | None:
        """Return (distance in metres, [lon, lat] path) between two (lat, lon) points."""
        key = (round(start[0], 5), round(start[1], 5), round(end[0], 5), round(end[1], 5))
        if key in self._cache:
            return self._cache[key]
        result: tuple[float, list[list[float]]] | None = None
        try:
            response = self.client.calculate_route(
                CalculatorName=self.calculator_name,
                DeparturePosition=[start[1], start[0]],
                DestinationPosition=[end[1], end[0]],
                TravelMode="Walking",
                DistanceUnit="Kilometers",
                IncludeLegGeometry=True,
            )
            coordinates = [
                point[:2]
                for leg in response["Legs"]
                for point in leg["Geometry"]["LineString"]
            ]
            if len(coordinates) >= 2:
                result = (response["Summary"]["Distance"] * 1000, coordinates)
        except Exception:
            result = None
        self._cache[key] = result
        return result
