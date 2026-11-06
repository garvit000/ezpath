import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILES } from '../src/stores/journeyStore';
import { AwsApiClient } from '../src/services/api/awsClient';
import {
  AwsRouteResponse,
  buildAwsRouteRequest,
  mapAwsRouteResponse,
} from '../src/services/api/awsContract';
import { JourneyRoute, JourneySearchRequest } from '../src/types';
import { routePassesNear } from '../src/utils/geo';
import {
  AwsJourneyResponse,
  buildAwsJourneyRequest,
  isCampusPair,
  mapAwsJourneyResponse,
} from '../src/services/api/awsJourneyContract';
import { fareLabel } from '../src/utils/fare';


function searchRequest(strictVerification = true): JourneySearchRequest {
  return {
    originId: 'srm-library',
    destinationId: 'srm-medical-college-hospital',
    departureTime: '2026-11-06T09:00:00+05:30',
    profile: {
      ...DEFAULT_PROFILES.wheelchair,
      strictVerification,
      maxWalkingDistanceMeters: 2500,
    },
  };
}

function routeResponse(accessibility: 'ACCESSIBLE' | 'UNKNOWN' = 'UNKNOWN'): AwsRouteResponse {
  const unknown = accessibility === 'UNKNOWN';
  return {
    request_id: 'request-123',
    status: 'ok',
    graph: { version: 'osm-test-v1', source: 'OpenStreetMap via OSMnx', crs: 'epsg:4326' },
    snapped_points: {},
    routes: [{
      route_id: 'route-1',
      nodes: [100, 200],
      edges: [{
        from: 100,
        to: 200,
        key: 0,
        mode: 'walk',
        distance_m: 420.5,
        duration_min: 7.01,
        accessibility,
        reason_code: unknown ? 'ALLOWED_WITH_UNKNOWN_ACCESSIBILITY' : 'ACCESSIBILITY_TAG_SUPPORTED',
        osm_tags: { highway: 'footway' },
      }],
      metrics: {
        duration_min: 7.01,
        walking_distance_m: 420.5,
        uncertainty_points: unknown ? 100 : 0,
        unknown_accessibility_edges: unknown ? 1 : 0,
        transfer_count: 0,
      },
      accessibility: {
        status: unknown ? 'uncertain' : 'tag_supported',
        policy: unknown ? 'relaxed' : 'strict',
        wheelchair_profile: true,
        warnings: unknown ? ['1 route edge(s) have unknown wheelchair accessibility.'] : [],
      },
      geometry: {
        type: 'LineString',
        coordinates: [[80.0426, 12.8230], [80.0476, 12.8212]],
      },
      diagnostics: { search_expansions: 12, search_complete: true, label_cap_hit: false },
    }],
    status_overlay: { active_events: 1, blocking_events: 1, blocked_entity_ids: ['edge:1:2:0'] },
    message: null,
  };
}

describe('AWS route contract adapter', () => {
  it('translates selected SRM locations and strict profile to the backend contract', () => {
    const payload = buildAwsRouteRequest(searchRequest(true), 'request-123');

    expect(payload.request_id).toBe('request-123');
    expect(payload.origin).toEqual({ latitude: 12.8232845, longitude: 80.0425857 });
    expect(payload.destination).toEqual({ latitude: 12.8210402, longitude: 80.0479585 });
    expect(payload.profile).toEqual({
      wheelchair_user: true,
      unknown_accessibility_policy: 'strict',
      walking_speed_mps: 1,
    });
    expect(payload.constraints).toEqual({
      max_walking_distance_m: 2500,
      max_snap_distance_m: 100,
      max_routes: 3,
    });
  });

  it('keeps unknown OpenStreetMap evidence visibly unverified', () => {
    const routes = mapAwsRouteResponse(
      routeResponse('UNKNOWN'),
      searchRequest(false),
      '2026-11-06T04:00:00Z',
    );

    expect(routes[0].accessibilityStatus).toBe('uncertain');
    expect(routes[0].isStepFree).toBe(false);
    expect(routes[0].isFeasible).toBe(true);
    expect(routes[0].evidenceConfidence).toBe('low');
    expect(routes[0].reliabilityScore).toBeNull();
    expect(routes[0].explanation.evaluations[0].status).toBe('unverified');
  });

  it('uses POST /v1/routes and maps the canonical response', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(routeResponse('ACCESSIBLE')),
    } as Response));
    const client = new AwsApiClient({
      baseUrl: 'https://api.example.test/',
      fetchImpl: fetchImpl as typeof fetch,
      getToken: () => 'operator-token',
      requestId: () => 'request-123',
    });

    const result = await client.searchRoutes(searchRequest(true));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/routes');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer operator-token' });
    expect(JSON.parse(String(init?.body)).origin).toEqual({
      latitude: 12.8232845,
      longitude: 80.0425857,
    });
    expect(result.graphVersion).toBe('osm-test-v1');
    expect(result.routes[0].accessibilityStatus).toBe('verified');
  });

  it('surfaces the backend error message', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ error: { message: 'SNAP_DISTANCE_EXCEEDED' } }),
    } as Response));
    const client = new AwsApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: fetchImpl as typeof fetch,
      getToken: () => null,
    });

    await expect(client.searchRoutes(searchRequest())).rejects.toThrow('SNAP_DISTANCE_EXCEEDED');
  });

  it('calls the default browser fetch without binding it to the client', async () => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async function (this: unknown) {
      // Browsers reject fetch when it is called as a method of another object.
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return new Response(JSON.stringify({ status: 'ok', graph_version: 'osm-test-v1' }), { status: 200 });
    } as typeof fetch);

    try {
      const client = new AwsApiClient({ baseUrl: 'https://api.example.test', getToken: () => null });

      await expect(client.getHealth()).resolves.toMatchObject({ status: 'ok', mode: 'aws' });
      expect(browserFetch).toHaveBeenCalledTimes(1);
    } finally {
      browserFetch.mockRestore();
    }
  });
});


describe('Chennai journeys', () => {
  const chennaiRequest = (): JourneySearchRequest => ({
    originId: 'rail-chennai-central-suburban',
    destinationId: 'srm-library',
    departureTime: '2026-11-09T09:00:00+05:30',
    profile: { ...DEFAULT_PROFILES.standard },
  });

  const journeyResponse = (): AwsJourneyResponse => ({
    request_id: 'request-123',
    status: 'ok',
    message: null,
    transit: { sources: [] },
    journeys: [{
      journey_id: 'journey-1',
      departure: '09:05',
      arrival: '10:32',
      metrics: { duration_min: 87.4, walking_distance_m: 1043.1, transfers: 1 },
      fare: { known_inr: 40, complete: false, unknown_modes: ['bus'] },
      modes: ['bus', 'metro', 'walk'],
      accessibility: { status: 'uncertain', wheelchair_profile: false, warnings: [] },
      notes: ['Fares are not published in the MTC bus data, so the total is incomplete.'],
      legs: [
        {
          mode: 'walk', from: { name: 'Start', latitude: 13, longitude: 80.2 }, to: { name: 'Alpha', latitude: 13, longitude: 80.21 },
          departure: '09:05', arrival: '09:10', duration_min: 5, distance_m: 300, walk_source: 'estimated', fare_inr: 0,
          geometry: [[80.2, 13], [80.21, 13]],
        },
        {
          mode: 'metro', from: { name: 'Alpha', latitude: 13, longitude: 80.21 }, to: { name: 'Bravo', latitude: 13.1, longitude: 80.21 },
          departure: '09:15', arrival: '09:35', duration_min: 20, distance_m: 9000, route_name: 'SWN-SAP', stop_count: 6, fare_inr: 40,
          geometry: [[80.21, 13], [80.21, 13.1]],
        },
        {
          mode: 'bus', from: { name: 'Bravo', latitude: 13.1, longitude: 80.21 }, to: { name: 'End', latitude: 13.2, longitude: 80.21 },
          departure: '09:45', arrival: '10:32', duration_min: 47, distance_m: 12000, route_name: '500', stop_count: 1, fare_inr: null,
          geometry: [[80.21, 13.1], [80.21, 13.2]],
        },
      ],
    }],
  });

  it('sends city trips to POST /v1/journeys with the selected modes', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(journeyResponse()),
    } as Response));
    const client = new AwsApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: fetchImpl as typeof fetch,
      getToken: () => null,
      requestId: () => 'request-123',
    });

    const result = await client.searchRoutes(chennaiRequest());

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/journeys');
    expect(JSON.parse(String(init?.body)).constraints.modes).toEqual(['bus', 'metro', 'rail']);
    expect(result.routes[0].arrivalTime).toBe('10:32');
  });

  it('passes lift dependency and preserves the backend decision', async () => {
    const response = journeyResponse();
    response.decision = { status: 'NEEDS_CONFIRMATION', missingFacts: [{
      question: 'Is the Potheri lift operational?', affectedRouteIds: ['journey-1'],
    }] };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200,
      text: async () => JSON.stringify(response) } as Response));
    const client = new AwsApiClient({ baseUrl: 'https://api.example.test',
      fetchImpl: fetchImpl as typeof fetch, getToken: () => null });
    const request = chennaiRequest();
    request.profile = { ...DEFAULT_PROFILES.limited_walking };

    const result = await client.searchRoutes(request);

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).profile.requires_lift_status).toBe(true);
    expect(result.decision?.status).toBe('NEEDS_CONFIRMATION');
    expect(result.routes[0].categoryTags).toEqual([]);
  });

  it('keeps trips inside the campus on the walking graph endpoint', () => {
    expect(isCampusPair('srm-library', 'srm-global-hospitals')).toBe(true);
    expect(isCampusPair('rail-chennai-central-suburban', 'srm-library')).toBe(false);
  });

  it('shows ETA and never presents a partial fare as the full cost', () => {
    const [route] = mapAwsJourneyResponse(journeyResponse(), chennaiRequest(), '2026-11-09T03:30:00Z');

    expect(route.label).toBe('Metro and Bus journey');
    expect(route.departureTime).toBe('09:05');
    expect(route.totalDurationMinutes).toBe(87.4);
    expect(route.transportModes).toEqual(['walking', 'metro', 'bus']);
    expect(route.accessibilityStatus).toBe('uncertain');
    expect(route.legs[1].lineName).toBe('Metro SWN-SAP');
    expect(route.legs[1].steps[0].accessUnknown).toBe(true);
    expect(route.geometry).toHaveLength(6);
    expect(fareLabel(route.totalFareINR, route.fareStatus)).toBe('₹40 + other fares');
    expect(fareLabel(0, 'partial')).toBe('Fare not published');
    expect(fareLabel(30, 'complete')).toBe('₹30');
  });

  it('rejects a search with every transit mode turned off', () => {
    const request = chennaiRequest();
    request.profile = { ...request.profile, allowedModes: ['walking'] };

    expect(() => buildAwsJourneyRequest(request, 'request-123')).toThrow('at least one transit mode');
  });
});

describe('routePassesNear', () => {
  const route = { legs: [{ geometry: [[80.0, 13.0], [80.01, 13.0]] }], geometry: [] } as unknown as JourneyRoute;

  it('matches a disruption on the route and ignores one far away', () => {
    expect(routePassesNear(route, 13.0005, 80.01)).toBe(true);
    expect(routePassesNear(route, 13.05, 80.01)).toBe(false);
  });
});
