import { 
  JourneySearchRequest, 
  JourneyRoute, 
  DisruptionEvent, 
  FacilityStatus, 
  NetworkNode, 
  NetworkEdge,
  DisruptionDiff
} from '../../types';

export interface RouteSearchResult {
  routes: JourneyRoute[];
  searchTimestamp: string;
  graphVersion: string;
  message?: string | null;
  decision?: {
    status: 'READY' | 'NEEDS_CONFIRMATION' | 'OPTIONS_ONLY';
    missingFacts: Array<{ question: string; whyItMatters?: string; affectedRouteIds: string[] }>;
  };
}

export interface ReplanResult {
  previousRoute: JourneyRoute;
  newRoute: JourneyRoute;
  diff: DisruptionDiff;
  success: boolean;
}

export interface NetworkEntitiesResult {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  facilities: FacilityStatus[];
  graphVersion: string;
}

export interface ApiClient {
  searchRoutes(request: JourneySearchRequest): Promise<RouteSearchResult>;
  replanRoute(routeId: string, request: JourneySearchRequest): Promise<ReplanResult>;
  getNetworkEntities(): Promise<NetworkEntitiesResult>;
  getActiveEvents(): Promise<DisruptionEvent[]>;
  createEvent(event: Omit<DisruptionEvent, 'id'>): Promise<DisruptionEvent>;
  resolveEvent(eventId: string): Promise<boolean>;
  resetDemo(): Promise<boolean>;
  getHealth(): Promise<{ status: string; mode: 'demo' | 'aws'; version: string }>;
}

