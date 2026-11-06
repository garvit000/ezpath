import {
  JourneyRoute,
  JourneySearchRequest,
  RouteLeg,
  TransportMode,
} from '../../types';
import { getCampusLocation, getCatalogLocation, JourneyLocation } from '../../data/networkLocations';

type BackendMode = 'bus' | 'metro' | 'rail';

interface AwsPoint {
  name: string;
  latitude: number;
  longitude: number;
}

export interface AwsJourneyRequest {
  request_id: string;
  origin: AwsPoint;
  destination: AwsPoint;
  departure_time: string;
  profile: {
    wheelchair_user: boolean;
    requires_lift_status: boolean;
    unknown_accessibility_policy: 'strict' | 'relaxed';
    walking_speed_mps: number;
  };
  constraints: {
    max_walking_distance_m: number;
    max_routes: number;
    modes: BackendMode[];
  };
}

interface AwsJourneyLeg {
  mode: 'walk' | BackendMode;
  from: AwsPoint;
  to: AwsPoint;
  departure: string;
  arrival: string;
  duration_min: number;
  distance_m: number;
  walk_source?: 'campus_graph' | 'estimated';
  route_name?: string;
  route_description?: string;
  stop_count?: number;
  fare_inr: number | null;
  geometry: [number, number][];
}

interface AwsJourney {
  journey_id: string;
  departure: string;
  arrival: string;
  metrics: { duration_min: number; walking_distance_m: number; transfers: number };
  fare: { known_inr: number; complete: boolean; unknown_modes: BackendMode[] };
  modes: Array<'walk' | BackendMode>;
  legs: AwsJourneyLeg[];
  accessibility: { status: 'uncertain'; wheelchair_profile: boolean; warnings: string[] };
  notes: string[];
}

export interface AwsJourneyResponse {
  request_id: string | null;
  status: 'ok' | 'no_route';
  journeys: AwsJourney[];
  message: string | null;
  transit: { sources: Array<{ id: string; name: string }> };
  decision?: { status: 'READY' | 'NEEDS_CONFIRMATION' | 'OPTIONS_ONLY'; missingFacts: Array<{
    question: string; whyItMatters?: string; affectedRouteIds: string[];
  }> };
}

const MODE_NAMES: Record<BackendMode, string> = { bus: 'Bus', metro: 'Metro', rail: 'Suburban train' };

export function isCampusPair(originId: string, destinationId: string): boolean {
  return Boolean(getCampusLocation(originId) && getCampusLocation(destinationId));
}

function point(location: JourneyLocation): AwsPoint {
  return { name: location.name, latitude: location.latitude, longitude: location.longitude };
}

function selectedModes(allowed: TransportMode[]): BackendMode[] {
  const modes: BackendMode[] = [];
  if (allowed.includes('bus')) modes.push('bus');
  if (allowed.includes('metro')) modes.push('metro');
  if (allowed.includes('train')) modes.push('rail');
  return modes;
}

export function buildAwsJourneyRequest(request: JourneySearchRequest, requestId: string): AwsJourneyRequest {
  const origin = getCatalogLocation(request.originId);
  const destination = getCatalogLocation(request.destinationId);
  if (!origin || !destination) {
    throw new Error('Select an available Chennai or SRM location before searching.');
  }
  const modes = selectedModes(request.profile.allowedModes);
  if (modes.length === 0) throw new Error('Select at least one transit mode.');
  return {
    request_id: requestId,
    origin: point(origin),
    destination: point(destination),
    departure_time: request.departureTime,
    profile: {
      wheelchair_user: request.profile.id === 'wheelchair'
        || request.profile.requireStepFree
        || request.profile.requireWheelchairBoarding
        || request.profile.avoidStairs,
      requires_lift_status: request.profile.requireOperationalLiftOrRamp,
      unknown_accessibility_policy: request.profile.strictVerification ? 'strict' : 'relaxed',
      walking_speed_mps: 1.0,
    },
    constraints: {
      max_walking_distance_m: request.profile.maxWalkingDistanceMeters,
      max_routes: 4,
      modes,
    },
  };
}

function transportMode(leg: AwsJourneyLeg): TransportMode {
  if (leg.mode === 'walk') return 'walking';
  return leg.mode === 'rail' ? 'train' : leg.mode;
}

function legName(leg: AwsJourneyLeg): string | undefined {
  return leg.mode === 'walk' ? undefined : `${MODE_NAMES[leg.mode]} ${leg.route_name ?? ''}`.trim();
}

function instruction(leg: AwsJourneyLeg): string {
  if (leg.mode === 'walk') {
    const distance = Math.round(leg.distance_m);
    return leg.walk_source === 'campus_graph'
      ? `Walk ${distance} m to ${leg.to.name} on mapped campus paths.`
      : `Walk about ${distance} m to ${leg.to.name}. This distance is an estimate.`;
  }
  const stops = leg.stop_count === 1 ? '1 stop' : `${leg.stop_count} stops`;
  return `Board ${legName(leg)} at ${leg.from.name} at ${leg.departure}. Ride ${stops} to ${leg.to.name}, arriving ${leg.arrival}.`;
}

function mapLeg(leg: AwsJourneyLeg, journeyId: string, index: number, timestamp: string): RouteLeg {
  const isWalk = leg.mode === 'walk';
  return {
    id: `${journeyId}-leg-${index}`,
    fromNodeId: leg.from.name,
    fromNodeName: leg.from.name,
    toNodeId: leg.to.name,
    toNodeName: leg.to.name,
    mode: transportMode(leg),
    legType: isWalk ? 'walk' : leg.mode === 'bus' ? 'bus' : 'train',
    lineName: legName(leg),
    durationMinutes: leg.duration_min,
    distanceMeters: leg.distance_m,
    fareINR: leg.fare_inr ?? 0,
    stepFree: false,
    wheelchairAccessible: false,
    evidenceSource: isWalk
      ? (leg.walk_source === 'campus_graph' ? 'openstreetmap' : 'unknown')
      : 'published_timetable',
    evidenceTimestamp: timestamp,
    confidenceScore: null,
    geometry: leg.geometry,
    steps: [{
      instruction: instruction(leg),
      distanceMeters: leg.distance_m,
      durationMinutes: leg.duration_min,
      stepFree: false,
      accessUnknown: true,
    }],
  };
}

function journeyLabel(journey: AwsJourney): string {
  const names = journey.legs.filter((leg) => leg.mode !== 'walk').map((leg) => MODE_NAMES[leg.mode as BackendMode]);
  const unique = [...new Set(names)];
  return unique.length ? `${unique.join(' and ')} journey` : 'Walking route';
}

function mapJourney(
  journey: AwsJourney,
  request: JourneySearchRequest,
  timestamp: string,
): JourneyRoute {
  const transportModes = [...new Set(journey.legs.map(transportMode))];
  const notes = [...journey.accessibility.warnings, ...journey.notes];
  return {
    id: journey.journey_id,
    label: journeyLabel(journey),
    categoryTags: [],
    totalDurationMinutes: journey.metrics.duration_min,
    totalDistanceMeters: journey.legs.reduce((total, leg) => total + leg.distance_m, 0),
    walkingDistanceMeters: journey.metrics.walking_distance_m,
    totalFareINR: journey.fare.known_inr,
    fareStatus: journey.fare.complete ? 'complete' : 'partial',
    transfersCount: journey.metrics.transfers,
    transportModes,
    legs: journey.legs.map((leg, index) => mapLeg(leg, journey.journey_id, index, timestamp)),
    isStepFree: false,
    isWheelchairAccessible: false,
    accessibilityStatus: 'uncertain',
    isFeasible: true,
    feasibilityReason: 'This journey fits your walking limit, but its step-free access has not been verified.',
    reliabilityScore: null,
    evidenceConfidence: 'low',
    explanation: {
      summary: 'Times come from published timetables, not live vehicle positions. The feeds do not record step-free access, so this journey is not verified as accessible.',
      evaluations: [
        {
          constraintId: 'walking_distance',
          name: 'Maximum walking distance',
          status: 'passed',
          userLimit: `${request.profile.maxWalkingDistanceMeters} m maximum`,
          routeValue: `${Math.round(journey.metrics.walking_distance_m)} m`,
          evidenceSource: 'Campus paths and estimated street distance',
          lastUpdated: `Route response ${timestamp}`,
          isHardRequirement: true,
        },
        {
          constraintId: 'accessibility_evidence',
          name: 'Recorded accessibility evidence',
          status: 'unverified',
          userLimit: request.profile.strictVerification ? 'Verified data required' : 'Unknown data permitted with warning',
          routeValue: 'Transit feeds publish no wheelchair-boarding data',
          evidenceSource: 'CMRL, Southern Railway and CUMTA feeds',
          lastUpdated: `Route response ${timestamp}`,
          isHardRequirement: request.profile.strictVerification,
          notes: 'Confirm lifts, ramps and boarding with the operator before travelling.',
        },
      ],
      confidenceLevel: 'uncertain',
      unknownDataPoints: notes,
      reasons: [
        `Walking distance is ${Math.round(journey.metrics.walking_distance_m)} m.`,
        `${journey.metrics.transfers} transfer(s).`,
      ],
    },
    dataNotes: notes,
    geometry: journey.legs.flatMap((leg) => leg.geometry),
    departureTime: journey.departure,
    arrivalTime: journey.arrival,
    dependentLifts: [],
  };
}

export function mapAwsJourneyResponse(
  response: AwsJourneyResponse,
  request: JourneySearchRequest,
  timestamp = new Date().toISOString(),
): JourneyRoute[] {
  const routes = response.journeys.map((journey) => mapJourney(journey, request, timestamp));
  if (response.decision?.status !== undefined && response.decision.status !== 'READY') return routes;
  if (routes.length === 0) return routes;
  const fastest = Math.min(...routes.map((route) => route.totalDurationMinutes));
  const leastWalking = Math.min(...routes.map((route) => route.walkingDistanceMeters));
  const priced = routes.filter((route) => route.fareStatus === 'complete');
  const cheapest = priced.length ? Math.min(...priced.map((route) => route.totalFareINR)) : null;
  for (const route of routes) {
    if (route.totalDurationMinutes === fastest) route.categoryTags.push('fastest');
    if (route.walkingDistanceMeters === leastWalking) route.categoryTags.push('least_walking');
    if (route.fareStatus === 'complete' && route.totalFareINR === cheapest) route.categoryTags.push('cheapest');
  }
  return routes;
}
