import { ApiClient, NetworkEntitiesResult, ReplanResult, RouteSearchResult } from './client';
import { DisruptionDiff, DisruptionEvent, JourneyRoute, JourneySearchRequest } from '../../types';
import { CAMPUS_NETWORK_NODES } from '../../data/networkLocations';
import { authService } from '../auth/cognito';
import {
  AwsRouteResponse,
  buildAwsRouteRequest,
  mapAwsRouteResponse,
} from './awsContract';
import {
  AwsJourneyResponse,
  buildAwsJourneyRequest,
  isCampusPair,
  mapAwsJourneyResponse,
} from './awsJourneyContract';

type FetchLike = typeof fetch;

interface AwsApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  getToken?: () => string | null;
  requestId?: () => string;
}

interface AwsHealthResponse {
  status: string;
  graph_version: string;
  nodes?: number;
  edges?: number;
}

function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `journey-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AwsApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly getToken: () => string | null;
  private readonly requestId: () => string;
  private readonly knownRoutes = new Map<string, JourneyRoute>();
  private graphVersion = 'unknown';

  constructor(options: AwsApiClientOptions = {}) {
    const configuredBaseUrl = options.baseUrl ?? import.meta.env.VITE_API_BASE_URL;
    if (!configuredBaseUrl) {
      throw new Error('VITE_API_BASE_URL is required when VITE_DEMO_MODE=false.');
    }
    this.baseUrl = configuredBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.getToken = options.getToken ?? (() => authService.getAccessToken());
    this.requestId = options.requestId ?? defaultRequestId;
  }

  private getAuthHeaders(): HeadersInit {
    const token = this.getToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.getAuthHeaders(), ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`AWS API returned invalid JSON with status ${response.status}.`);
      }
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `request failed with status ${response.status}`;
      throw new Error(detail);
    }
    return payload as T;
  }

  async searchRoutes(request: JourneySearchRequest): Promise<RouteSearchResult> {
    if (!isCampusPair(request.originId, request.destinationId)) {
      return this.searchJourneys(request);
    }
    const canonicalRequest = buildAwsRouteRequest(request, this.requestId());
    const response = await this.requestJson<AwsRouteResponse>('/v1/routes', {
      method: 'POST',
      body: JSON.stringify(canonicalRequest),
    });
    const searchTimestamp = new Date().toISOString();
    const routes = mapAwsRouteResponse(response, request, searchTimestamp);
    this.graphVersion = response.graph.version;
    for (const route of routes) this.knownRoutes.set(route.id, route);
    return {
      routes,
      searchTimestamp,
      graphVersion: response.graph.version,
      message: response.message,
    };
  }

  private async searchJourneys(request: JourneySearchRequest): Promise<RouteSearchResult> {
    const response = await this.requestJson<AwsJourneyResponse>('/v1/journeys', {
      method: 'POST',
      body: JSON.stringify(buildAwsJourneyRequest(request, this.requestId())),
    });
    const searchTimestamp = new Date().toISOString();
    const routes = mapAwsJourneyResponse(response, request, searchTimestamp);
    for (const route of routes) this.knownRoutes.set(route.id, route);
    return { routes, searchTimestamp, graphVersion: this.graphVersion, message: response.message, decision: response.decision };
  }

  async replanRoute(routeId: string, request: JourneySearchRequest): Promise<ReplanResult> {
    const previousRoute = this.knownRoutes.get(routeId);
    if (!previousRoute) {
      throw new Error('The previous route is no longer available. Search again before replanning.');
    }
    const result = await this.searchRoutes(request);
    const newRoute = result.routes[0];
    if (!newRoute) {
      throw new Error(result.message || 'No route satisfies the current accessibility constraints.');
    }
    const diff: DisruptionDiff = {
      previousRoute,
      newRoute,
      durationChangeMinutes: Number((newRoute.totalDurationMinutes - previousRoute.totalDurationMinutes).toFixed(2)),
      fareChangeINR: newRoute.totalFareINR - previousRoute.totalFareINR,
      walkingDistanceChangeMeters: Number((newRoute.walkingDistanceMeters - previousRoute.walkingDistanceMeters).toFixed(1)),
      transfersChange: newRoute.transfersCount - previousRoute.transfersCount,
      stepFreeMaintained: newRoute.accessibilityStatus === 'verified',
      affectedFacilityName: 'Current network disruption',
      disruptionReason: 'Route recalculated against the latest active-event overlay.',
    };
    return { previousRoute, newRoute, diff, success: true };
  }

  async getNetworkEntities(): Promise<NetworkEntitiesResult> {
    if (this.graphVersion === 'unknown') {
      try {
        await this.getHealth();
      } catch {
        // Location selection remains available while backend health recovers.
      }
    }
    return {
      nodes: CAMPUS_NETWORK_NODES,
      edges: [],
      facilities: [],
      graphVersion: this.graphVersion,
    };
  }

  async getActiveEvents(): Promise<DisruptionEvent[]> {
    return this.requestJson<DisruptionEvent[]>('/v1/events/active', { method: 'GET' });
  }

  async createEvent(event: Omit<DisruptionEvent, 'id'>): Promise<DisruptionEvent> {
    return this.requestJson<DisruptionEvent>('/v1/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  async resolveEvent(eventId: string): Promise<boolean> {
    const result = await this.requestJson<{ resolved: boolean }>(
      `/v1/events/${encodeURIComponent(eventId)}/resolve`,
      { method: 'POST' },
    );
    return result.resolved === true;
  }

  async resetDemo(): Promise<boolean> {
    return false;
  }

  async getHealth(): Promise<{ status: string; mode: 'demo' | 'aws'; version: string }> {
    const health = await this.requestJson<AwsHealthResponse>('/health', { method: 'GET' });
    this.graphVersion = health.graph_version;
    return { status: health.status, mode: 'aws', version: health.graph_version };
  }
}
