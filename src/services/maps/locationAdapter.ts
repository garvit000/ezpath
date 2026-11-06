export interface MapConfig {
  style: string | null;
  satelliteStyle: string | null;
  provider: 'amazon-location';
  configurationError: string | null;
  defaultCenter: [number, number];
  defaultZoom: number;
  minZoom: number;
  maxZoom: number;
  maxBounds: [[number, number], [number, number]];
}

export interface LocationMapOptions {
  mapName?: string;
  satelliteMapName?: string;
  region?: string;
  apiKey?: string;
  demoMode?: boolean;
}

export class LocationMapAdapter {
  private readonly mapName?: string;
  private readonly satelliteMapName?: string;
  private readonly region?: string;
  private readonly apiKey?: string;

  constructor(options: LocationMapOptions = {}) {
    this.mapName = options.mapName ?? import.meta.env.VITE_LOCATION_MAP_NAME;
    this.satelliteMapName = options.satelliteMapName ?? import.meta.env.VITE_LOCATION_SATELLITE_MAP_NAME;
    this.region = options.region ?? import.meta.env.VITE_AWS_REGION;
    this.apiKey = options.apiKey ?? import.meta.env.VITE_LOCATION_API_KEY;
  }

  getMapConfig(): MapConfig {
    const hasAwsConfig = Boolean(this.mapName && this.region && this.apiKey);
    const styleUrl = (name?: string) => (hasAwsConfig && name
      ? `https://maps.geo.${this.region}.amazonaws.com/maps/v0/maps/${encodeURIComponent(
          name,
        )}/style-descriptor?key=${encodeURIComponent(this.apiKey!)}`
      : null);
    const style = styleUrl(this.mapName);

    return {
      style,
      satelliteStyle: styleUrl(this.satelliteMapName),
      provider: 'amazon-location',
      configurationError: hasAwsConfig
        ? null
        : 'Amazon Location is not configured for this build. Add the map name, AWS Region, and browser API key.',
      defaultCenter: [80.14, 12.95],
      defaultZoom: 10,
      minZoom: 8.5,
      maxZoom: 19,
      maxBounds: [
        [79.5, 12.3],
        [80.7, 13.7],
      ],
    };
  }

  calculateBounds(
    coordinates: [number, number][],
  ): [[number, number], [number, number]] | null {
    if (!coordinates || coordinates.length === 0) return null;

    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    for (const [lng, lat] of coordinates) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }

    const lngPadding = (maxLng - minLng) * 0.1 || 0.005;
    const latPadding = (maxLat - minLat) * 0.1 || 0.005;

    return [
      [minLng - lngPadding, minLat - latPadding],
      [maxLng + lngPadding, maxLat + latPadding],
    ];
  }
}

export const locationMapAdapter = new LocationMapAdapter();
