import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import { ACTIVE_NETWORK_NODES } from '../../data/networkLocations';
import { locationMapAdapter } from '../../services/maps/locationAdapter';
import { JourneyRoute, NetworkNode } from '../../types';

export type MapView = 'street' | 'satellite';

interface MapLibreCanvasProps {
  selectedRoute?: JourneyRoute;
  view: MapView;
  onSelectEntity: (entity: NetworkNode) => void;
}

const ROUTE_SOURCE_ID = 'ezpath-selected-route';
const ROUTE_CASING_LAYER_ID = 'ezpath-selected-route-casing';
const ROUTE_LAYER_ID = 'ezpath-selected-route-line';
const WALK_LAYER_ID = 'ezpath-selected-route-walk';

function routeFeatures(route?: JourneyRoute) {
  const legs = route?.legs.filter((leg) => leg.geometry.length >= 2) ?? [];
  const parts = legs.length
    ? legs.map((leg) => ({ mode: String(leg.mode), coordinates: leg.geometry }))
    : route?.geometry.length
      ? [{ mode: 'walking', coordinates: route.geometry }]
      : [];
  return {
    type: 'FeatureCollection' as const,
    features: parts.map((part) => ({
      type: 'Feature' as const,
      properties: { mode: part.mode },
      geometry: { type: 'LineString' as const, coordinates: part.coordinates },
    })),
  };
}

function addRouteLayers(map: MapLibreMap, route?: JourneyRoute) {
  map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: routeFeatures(route) });
  map.addLayer({
    id: ROUTE_CASING_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: ROUTE_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['!=', ['get', 'mode'], 'walking'],
    paint: {
      'line-color': ['match', ['get', 'mode'], 'metro', '#0B5CAD', 'train', '#7A3E9D', 'bus', '#C2570C', '#087F6D'],
      'line-width': 5,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: WALK_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'mode'], 'walking'],
    paint: { 'line-color': '#087F6D', 'line-width': 5, 'line-dasharray': [1.2, 1.2] },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
}

export const MapLibreCanvas: React.FC<MapLibreCanvasProps> = ({ selectedRoute, view, onSelectEntity }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const routeRef = useRef(selectedRoute);
  routeRef.current = selectedRoute;
  const viewRef = useRef(view);
  const [mapError, setMapError] = useState<string | null>(null);
  const config = useMemo(() => locationMapAdapter.getMapConfig(), []);

  const fitRoute = (map: MapLibreMap, duration: number) => {
    const geometry = routeRef.current?.geometry;
    if (!geometry?.length) return;
    const bounds = locationMapAdapter.calculateBounds(geometry);
    if (!bounds) return;
    // Keep the route clear of the floating panels on wide screens.
    const wide = map.getContainer().clientWidth >= 1024;
    map.fitBounds(bounds, {
      padding: wide ? { top: 80, bottom: 70, left: 410, right: 430 } : 36,
      maxZoom: 17,
      duration,
    });
  };

  useEffect(() => {
    if (!containerRef.current || !config.style) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: config.style,
      center: config.defaultCenter,
      zoom: config.defaultZoom,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      maxBounds: config.maxBounds,
      attributionControl: { compact: true, customAttribution: 'Route data © OpenStreetMap contributors' },
    });
    mapRef.current = map;
    let styleReady = false;
    let fitted = false;
    map.on('error', () => {
      // A single failed tile after loading must not hide a working map.
      if (!styleReady) setMapError('The Amazon Location map could not be loaded. Check the map key and network connection.');
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

    // This also fires after a style change, which removes the route layers.
    map.on('style.load', () => {
      styleReady = true;
      setMapError(null);
      if (!map.getSource(ROUTE_SOURCE_ID)) addRouteLayers(map, routeRef.current);
      if (!fitted) {
        fitted = true;
        fitRoute(map, 0);
      }
    });

    markersRef.current = ACTIVE_NETWORK_NODES.map((node) => {
      const markerElement = document.createElement('button');
      markerElement.type = 'button';
      markerElement.className =
        'h-4 w-4 rounded-full border-2 border-white bg-slate-700 shadow-md focus:outline-none focus:ring-2 focus:ring-accent';
      markerElement.title = node.name;
      markerElement.setAttribute('aria-label', `Inspect ${node.name}`);
      markerElement.addEventListener('click', () => onSelectEntity(node));

      return new maplibregl.Marker({ element: markerElement })
        .setLngLat(node.coordinates)
        .addTo(map);
    });

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [config, onSelectEntity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || viewRef.current === view) return;
    viewRef.current = view;
    const style = view === 'satellite' ? config.satelliteStyle : config.style;
    if (style) map.setStyle(style);
  }, [view, config]);

  useEffect(() => {
    const map = mapRef.current;
    // The source exists only after the style loads, and that handler draws the latest route.
    const source = map?.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!map || !source) return;
    source.setData(routeFeatures(selectedRoute));
    fitRoute(map, 400);
  }, [selectedRoute]);

  const error = config.configurationError ?? mapError;
  return <>
    <div ref={containerRef} className="absolute inset-0 h-full w-full" />
    {error && <div role="alert" className="absolute inset-0 z-10 grid place-items-center bg-slate-100 p-8 text-center">
      <div className="max-w-md rounded-xl border border-amber-300 bg-white p-5 text-sm text-slate-700 shadow-sm">
        <strong className="mb-2 block text-slate-900">Amazon Location map unavailable</strong>
        {error}
      </div>
    </div>}
  </>;
};
