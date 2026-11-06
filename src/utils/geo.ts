import { JourneyRoute } from '../types';

const METRES_PER_DEGREE = 111_000;

/** True when any point of the route is within the given distance of a location. */
export function routePassesNear(
  route: JourneyRoute,
  latitude: number,
  longitude: number,
  limitMeters = 200,
): boolean {
  const longitudeScale = Math.cos((latitude * Math.PI) / 180);
  const limit = limitMeters / METRES_PER_DEGREE;
  const points = route.legs.some((leg) => leg.geometry.length > 0)
    ? route.legs.flatMap((leg) => leg.geometry)
    : route.geometry;
  return points.some(([lng, lat]) => Math.hypot((lng - longitude) * longitudeScale, lat - latitude) <= limit);
}
