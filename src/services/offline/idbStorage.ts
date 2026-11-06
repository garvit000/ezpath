import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { SavedJourney, JourneyRoute } from '../../types';

interface AccessPathDB extends DBSchema {
  saved_journeys: {
    key: string;
    value: SavedJourney;
    indexes: { 'by_saved_timestamp': string };
  };
}

const DB_NAME = 'accesspath_offline_db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<AccessPathDB>> | null = null;

function getDb(): Promise<IDBPDatabase<AccessPathDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AccessPathDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('saved_journeys', {
          keyPath: 'id',
        });
        store.createIndex('by_saved_timestamp', 'savedTimestamp');
      },
    });
  }
  return dbPromise;
}

export async function saveJourney(route: JourneyRoute, originName: string, destinationName: string): Promise<SavedJourney> {
  const db = await getDb();
  const savedItem: SavedJourney = {
    id: `saved_${Date.now()}`,
    routeId: route.id,
    originName,
    destinationName,
    departureTime: route.departureTime,
    arrivalTime: route.arrivalTime,
    totalDurationMinutes: route.totalDurationMinutes,
    totalFareINR: route.totalFareINR,
    fareStatus: route.fareStatus,
    walkingDistanceMeters: route.walkingDistanceMeters,
    transfersCount: route.transfersCount,
    transportModes: route.transportModes,
    dependentLifts: route.dependentLifts,
    legs: route.legs,
    explanation: route.explanation,
    savedTimestamp: new Date().toISOString(),
    lastKnownStatus: route.affectedByDisruption ? 'disrupted' : 'normal',
    geometry: route.geometry
  };

  await db.put('saved_journeys', savedItem);
  return savedItem;
}

export async function getAllSavedJourneys(): Promise<SavedJourney[]> {
  const db = await getDb();
  return db.getAllFromIndex('saved_journeys', 'by_saved_timestamp');
}

export async function getSavedJourneyById(id: string): Promise<SavedJourney | undefined> {
  const db = await getDb();
  return db.get('saved_journeys', id);
}

export async function deleteSavedJourney(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('saved_journeys', id);
}

export async function getSavedJourneyByRouteId(routeId: string): Promise<SavedJourney | undefined> {
  const journeys = await getAllSavedJourneys();
  return journeys.reverse().find((journey) => journey.routeId === routeId);
}

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' ? !navigator.onLine : false;
}

