import {
  ConstraintEvaluation,
  JourneyRoute,
  JourneySearchRequest,
  RouteLeg,
} from '../../types';
import { getCampusLocation } from '../../data/networkLocations';

export interface AwsRouteRequest {
  request_id: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  profile: {
    wheelchair_user: boolean;
    unknown_accessibility_policy: 'strict' | 'relaxed';
    walking_speed_mps: number;
  };
  constraints: {
    max_walking_distance_m: number;
    max_snap_distance_m: number;
    max_routes: number;
  };
}

interface AwsRouteEdge {
  from: string | number;
  to: string | number;
  key: string | number;
  mode: 'walk';
  distance_m: number;
  duration_min: number;
  accessibility: 'ACCESSIBLE' | 'INACCESSIBLE' | 'UNKNOWN';
  reason_code: string;
  osm_tags: Record<string, string>;
}

interface AwsRoute {
  route_id: string;
  nodes: Array<string | number>;
  edges: AwsRouteEdge[];
  metrics: {
    duration_min: number;
    walking_distance_m: number;
    uncertainty_points: number;
    unknown_accessibility_edges: number;
    transfer_count: number;
  };
  accessibility: {
    status: 'tag_supported' | 'uncertain';
    policy: 'strict' | 'relaxed';
    wheelchair_profile: boolean;
    warnings: string[];
  };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  diagnostics: {
    search_expansions?: number;
    search_complete?: boolean;
    label_cap_hit?: boolean;
  };
}

export interface AwsRouteResponse {
  request_id: string | null;
  status: 'ok' | 'no_route';
  graph: { version: string; source: string; crs: string };
  snapped_points: Record<string, unknown>;
  routes: AwsRoute[];
  status_overlay: {
    active_events: number;
    blocking_events: number;
    blocked_entity_ids: string[];
  };
  message: string | null;
}

export function buildAwsRouteRequest(
  request: JourneySearchRequest,
  requestId: string,
): AwsRouteRequest {
  const origin = getCampusLocation(request.originId);
  const destination = getCampusLocation(request.destinationId);
  if (!origin || !destination) {
    throw new Error('Select an available SRM campus location before searching.');
  }
  const wheelchairUser = request.profile.id === 'wheelchair'
    || request.profile.requireStepFree
    || request.profile.requireWheelchairBoarding
    || request.profile.avoidStairs;
  return {
    request_id: requestId,
    origin: { latitude: origin.latitude, longitude: origin.longitude },
    destination: { latitude: destination.latitude, longitude: destination.longitude },
    profile: {
      wheelchair_user: wheelchairUser,
      unknown_accessibility_policy: request.profile.strictVerification ? 'strict' : 'relaxed',
      walking_speed_mps: 1.0,
    },
    constraints: {
      max_walking_distance_m: request.profile.maxWalkingDistanceMeters,
      max_snap_distance_m: 100,
      max_routes: 3,
    },
  };
}

function clockTime(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function edgeLeg(
  edge: AwsRouteEdge,
  routeId: string,
  index: number,
  responseTimestamp: string,
): RouteLeg {
  const verified = edge.accessibility === 'ACCESSIBLE';
  const unknown = edge.accessibility === 'UNKNOWN';
  const fromName = `Mapped path node ${edge.from}`;
  const toName = `Mapped path node ${edge.to}`;
  return {
    id: `${routeId}-edge-${index}`,
    fromNodeId: String(edge.from),
    fromNodeName: fromName,
    toNodeId: String(edge.to),
    toNodeName: toName,
    mode: 'walking',
    legType: 'walk',
    durationMinutes: Math.max(0.01, Number(edge.duration_min.toFixed(2))),
    distanceMeters: Number(edge.distance_m.toFixed(1)),
    fareINR: 0,
    stepFree: verified,
    wheelchairAccessible: verified,
    evidenceSource: 'openstreetmap',
    evidenceTimestamp: responseTimestamp,
    confidenceScore: null,
    geometry: [],
    steps: [{
      instruction: unknown
        ? `Follow this mapped walking segment. Step-free details are not recorded for this segment.`
        : `Follow this mapped walking segment to ${toName}.`,
      distanceMeters: Number(edge.distance_m.toFixed(1)),
      durationMinutes: Math.max(0.01, Number(edge.duration_min.toFixed(2))),
      stepFree: verified,
      accessUnknown: unknown,
      hazardWarning: unknown ? 'Wheelchair accessibility is unverified in OpenStreetMap.' : undefined,
    }],
  };
}

function accessibilityEvaluations(
  route: AwsRoute,
  request: JourneySearchRequest,
  response: AwsRouteResponse,
  responseTimestamp: string,
  verified: boolean,
): ConstraintEvaluation[] {
  return [
    {
      constraintId: 'accessibility_evidence',
      name: 'Recorded accessibility evidence',
      status: verified ? 'passed' : 'unverified',
      userLimit: request.profile.strictVerification ? 'Verified tags required' : 'Unknown tags permitted with warning',
      routeValue: verified
        ? 'Every returned edge has supporting accessibility tags'
        : `${route.metrics.unknown_accessibility_edges} edge(s) have unknown wheelchair accessibility`,
      evidenceSource: 'OpenStreetMap tags',
      lastUpdated: `Route response ${responseTimestamp}`,
      isHardRequirement: request.profile.strictVerification,
      notes: verified
        ? 'Tag-supported does not mean an on-site physical audit.'
        : 'The route is allowed only because the selected profile permits unknown evidence.',
    },
    {
      constraintId: 'walking_distance',
      name: 'Maximum walking distance',
      status: route.metrics.walking_distance_m <= request.profile.maxWalkingDistanceMeters ? 'passed' : 'failed',
      userLimit: `${request.profile.maxWalkingDistanceMeters} m maximum`,
      routeValue: `${route.metrics.walking_distance_m} m`,
      evidenceSource: 'Routing graph edge lengths',
      lastUpdated: `Route response ${responseTimestamp}`,
      isHardRequirement: true,
    },
    {
      constraintId: 'live_disruptions',
      name: 'Active disruption overlay',
      status: 'passed',
      userLimit: 'Exclude exactly matched closures and outages',
      routeValue: `${response.status_overlay.blocking_events} blocking event(s) applied before routing`,
      evidenceSource: 'Current operator event snapshot',
      lastUpdated: `Route response ${responseTimestamp}`,
      isHardRequirement: true,
    },
  ];
}

function mapRoute(
  route: AwsRoute,
  response: AwsRouteResponse,
  request: JourneySearchRequest,
  responseTimestamp: string,
): JourneyRoute {
  const hasUnknown = route.edges.some((edge) => edge.accessibility === 'UNKNOWN');
  const hasInaccessible = route.edges.some((edge) => edge.accessibility === 'INACCESSIBLE');
  const requiresAccessibleEdges = request.profile.requireStepFree
    || request.profile.requireWheelchairBoarding
    || request.profile.avoidStairs;
  const verified = !hasUnknown && !hasInaccessible && route.accessibility.status === 'tag_supported';
  const accessibilityStatus = hasInaccessible ? 'inaccessible' : verified ? 'verified' : 'uncertain';
  const departure = new Date(request.departureTime);
  const safeDeparture = Number.isNaN(departure.valueOf()) ? new Date() : departure;
  const arrival = new Date(safeDeparture.valueOf() + route.metrics.duration_min * 60_000);
  const legs = route.edges.map((edge, index) => edgeLeg(edge, route.route_id, index, responseTimestamp));
  const warnings = [...route.accessibility.warnings];
  if (verified) warnings.push('Tag-supported accessibility has not been physically audited by EzPath.');
  return {
    id: route.route_id,
    label: verified ? 'Tag-supported walking route' : 'Walking route with unknown accessibility',
    categoryTags: [],
    totalDurationMinutes: route.metrics.duration_min,
    totalDistanceMeters: route.metrics.walking_distance_m,
    walkingDistanceMeters: route.metrics.walking_distance_m,
    totalFareINR: 0,
    transfersCount: route.metrics.transfer_count,
    transportModes: ['walking'],
    legs,
    isStepFree: verified,
    isWheelchairAccessible: verified && route.accessibility.wheelchair_profile,
    accessibilityStatus,
    isFeasible: !requiresAccessibleEdges || !hasInaccessible,
    feasibilityReason: verified
      ? 'All returned edges have supporting accessibility tags; no physical audit is implied.'
      : hasInaccessible && !requiresAccessibleEdges
      ? 'The selected standard profile does not require step-free travel; the route contains a segment recorded as inaccessible for wheelchair travel.'
      : 'The route satisfies the selected relaxed policy but contains unverified accessibility data.',
    reliabilityScore: null,
    evidenceConfidence: verified ? 'medium' : 'low',
    explanation: {
      summary: verified
        ? 'This route passed the requested constraints using recorded OpenStreetMap tags and the current disruption overlay. It is not a physical-accessibility certification.'
        : 'This route satisfies the selected relaxed policy, but one or more walking segments have unknown wheelchair accessibility.',
      evaluations: accessibilityEvaluations(route, request, response, responseTimestamp, verified),
      confidenceLevel: verified ? 'moderate' : 'uncertain',
      unknownDataPoints: warnings,
      reasons: [
        `Walking distance is ${route.metrics.walking_distance_m} m.`,
        `${response.status_overlay.blocking_events} active blocking event(s) were applied.`,
      ],
    },
    geometry: route.geometry.coordinates,
    departureTime: clockTime(safeDeparture),
    arrivalTime: clockTime(arrival),
    dependentLifts: [],
  };
}

export function mapAwsRouteResponse(
  response: AwsRouteResponse,
  request: JourneySearchRequest,
  responseTimestamp = new Date().toISOString(),
): JourneyRoute[] {
  const routes = response.routes.map((route) => mapRoute(route, response, request, responseTimestamp));
  if (routes.length === 0) return routes;
  const minimumDuration = Math.min(...routes.map((route) => route.totalDurationMinutes));
  const minimumWalking = Math.min(...routes.map((route) => route.walkingDistanceMeters));
  for (const route of routes) {
    if (route.totalDurationMinutes === minimumDuration) route.categoryTags.push('fastest');
    if (route.walkingDistanceMeters === minimumWalking) route.categoryTags.push('least_walking');
    if (route.accessibilityStatus === 'verified') route.categoryTags.push('accessible');
  }
  return routes;
}

