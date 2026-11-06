import { describe, expect, it } from 'vitest';
import {
  LocationMapAdapter,
} from '../src/services/maps/locationAdapter';

describe('LocationMapAdapter', () => {
  it('reports a configuration error instead of silently using another map provider', () => {
    const adapter = new LocationMapAdapter({
      mapName: 'EzPathSrmCampusMap',
      region: 'ap-south-1',
      apiKey: '',
      demoMode: false,
    });

    expect(adapter.getMapConfig()).toMatchObject({
      style: null,
      provider: 'amazon-location',
      defaultCenter: [80.14, 12.95],
      minZoom: 8.5,
    });
    expect(adapter.getMapConfig().configurationError).toContain('Amazon Location');
  });

  it('builds a key-authenticated Amazon Location style descriptor URL', () => {
    const adapter = new LocationMapAdapter({
      mapName: 'EzPath Campus',
      region: 'ap-south-1',
      apiKey: 'v1.public/key+value',
      demoMode: false,
    });

    expect(adapter.getMapConfig()).toMatchObject({
      provider: 'amazon-location',
      configurationError: null,
      style:
        'https://maps.geo.ap-south-1.amazonaws.com/maps/v0/maps/EzPath%20Campus/style-descriptor?key=v1.public%2Fkey%2Bvalue',
    });
  });

  it('pads calculated route bounds and returns null for an empty route', () => {
    const adapter = new LocationMapAdapter();

    expect(adapter.calculateBounds([])).toBeNull();
    expect(
      adapter.calculateBounds([
        [80.04, 12.82],
        [80.05, 12.83],
      ]),
    ).toEqual([
      [80.039, 12.819],
      [80.051, 12.831],
    ]);
  });
});

describe('LocationMapAdapter satellite view', () => {
  it('builds a satellite style from its own map resource', () => {
    const adapter = new LocationMapAdapter({
      mapName: 'Street',
      satelliteMapName: 'Satellite',
      region: 'ap-south-1',
      apiKey: 'key',
    });

    expect(adapter.getMapConfig().satelliteStyle).toBe(
      'https://maps.geo.ap-south-1.amazonaws.com/maps/v0/maps/Satellite/style-descriptor?key=key',
    );
  });
});
