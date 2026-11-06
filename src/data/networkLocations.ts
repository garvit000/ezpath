import campusCatalogJson from '../../traversal/routing/config/campus-locations.json';
import chennaiCatalogJson from '../../traversal/routing/config/chennai-locations.json';
import { isDemoMode } from '../config/runtime';
import { NetworkNode } from '../types';
import { DEMO_NODES } from './demoNetwork';

export interface JourneyLocation {
  id: string;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
}

interface CampusCatalog {
  graph_id: string;
  locations: Array<{
    id: string;
    name: string;
    category: string;
    latitude: number;
    longitude: number;
  }>;
}

const campusCatalog = campusCatalogJson as CampusCatalog;

export const CAMPUS_LOCATIONS: JourneyLocation[] = campusCatalog.locations.map((location) => ({
  id: location.id,
  name: location.name,
  category: location.category,
  latitude: location.latitude,
  longitude: location.longitude,
}));

const DEMO_LOCATIONS: JourneyLocation[] = DEMO_NODES.map((node) => ({
  id: node.id,
  name: node.name,
  category: node.type,
  latitude: node.coordinates[1],
  longitude: node.coordinates[0],
}));

const CHENNAI_LOCATIONS = (chennaiCatalogJson as { locations: JourneyLocation[] }).locations;

export interface LocationGroup {
  label: string;
  locations: JourneyLocation[];
}

const byCategory = (category: string) => CHENNAI_LOCATIONS.filter((location) => location.category === category);

export const LOCATION_GROUPS: LocationGroup[] = isDemoMode
  ? [{ label: 'Demo network', locations: DEMO_LOCATIONS }]
  : [
      { label: 'SRM Kattankulathur campus', locations: CAMPUS_LOCATIONS },
      { label: 'Chennai Metro stations', locations: byCategory('metro_station') },
      { label: 'Suburban railway stations', locations: byCategory('suburban_station') },
      { label: 'MTC bus termini', locations: byCategory('bus_terminus') },
    ];

export const ACTIVE_LOCATIONS = LOCATION_GROUPS.flatMap((group) => group.locations);
export const DEFAULT_ORIGIN_ID = isDemoMode ? 'node_central_station' : 'rail-chennai-central-suburban';
export const DEFAULT_DESTINATION_ID = isDemoMode ? 'node_riverside_campus' : 'srm-library';

export function getJourneyLocation(id: string): JourneyLocation | undefined {
  return ACTIVE_LOCATIONS.find((location) => location.id === id);
}

export function getCatalogLocation(id: string): JourneyLocation | undefined {
  return [...CAMPUS_LOCATIONS, ...CHENNAI_LOCATIONS].find((location) => location.id === id);
}

export function getCampusLocation(id: string): JourneyLocation | undefined {
  return CAMPUS_LOCATIONS.find((location) => location.id === id);
}

export function getJourneyLocationName(id: string): string {
  return getJourneyLocation(id)?.name ?? id;
}

function campusNodeType(category: string): NetworkNode['type'] {
  if (category === 'bus_stop' || category === 'transit_stop') return 'bus_stop';
  if (category === 'gate') return 'entrance';
  return 'destination';
}

export const CAMPUS_NETWORK_NODES: NetworkNode[] = CAMPUS_LOCATIONS.map((location) => ({
  id: location.id,
  name: location.name,
  type: campusNodeType(location.category),
  coordinates: [location.longitude, location.latitude],
  accessibilityStatus: 'unknown',
  isWheelchairAccessible: null,
  hasElevator: false,
  hasRamps: false,
  hasTactilePaving: false,
  facilities: [],
  zone: 'SRM Kattankulathur',
}));

export const ACTIVE_NETWORK_NODES = isDemoMode ? DEMO_NODES : CAMPUS_NETWORK_NODES;

export const ACTIVE_MAP_CONFIG = isDemoMode
  ? {
      subtitle: 'Demo multimodal corridor',
    }
  : {
      subtitle: 'Chennai and SRM campus',
    };

export const CAMPUS_GRAPH_ID = campusCatalog.graph_id;
