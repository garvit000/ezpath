import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAllSavedJourneys, deleteSavedJourney, isOffline } from '../services/offline/idbStorage';
import { SavedJourney } from '../types';
import { 
  Bookmark, 
  Trash2, 
  WifiOff, 
  Clock, 
  IndianRupee, 
  Footprints, 
  ArrowRight, 
  AlertTriangle,
  Compass
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Card, CardContent } from '../components/ui/Card';
import { fareLabel } from '../utils/fare';

export const SavedJourneys: React.FC = () => {
  const [savedJourneys, setSavedJourneys] = useState<SavedJourney[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [offline, setOffline] = useState(isOffline());

  const loadJourneys = async () => {
    setIsLoading(true);
    try {
      const items = await getAllSavedJourneys();
      setSavedJourneys(items.reverse());
    } catch {
      // Fallback
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadJourneys();

    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleDelete = async (id: string) => {
    await deleteSavedJourney(id);
    await loadJourneys();
  };

  return (
    <div className="product-page space-y-8">
      {/* Title */}
      <div data-reveal className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="text-xs font-semibold text-accent uppercase tracking-wider">
            Available offline
          </div>
          <h1 className="product-title">
            Your saved journeys
          </h1>
        </div>

        <Link to="/plan">
          <Button size="sm" variant="primary">
            Plan New Journey
          </Button>
        </Link>
      </div>

      {/* Offline Status Warning Bar if client is offline */}
      {offline && (
        <div className="p-4 rounded-xl bg-amber-50 border border-warning text-xs text-ink flex items-start gap-3">
          <WifiOff className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-bold text-warning">Offline Mode Active</div>
            <p className="text-slate-600">
              You are currently offline. Ezpath is showing your saved journeys. Live elevator updates and rerouting are unavailable until you reconnect.
            </p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && savedJourneys.length === 0 && (
        <div data-reveal className="text-center py-16 p-8 bg-white rounded-2xl border border-subtle-border shadow-card space-y-4">
          <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
            <Bookmark className="w-6 h-6" />
          </div>
          <h3 className="font-heading font-bold text-lg text-ink">No saved journeys found</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Save any route from the journey planner to access its turn-by-turn itinerary even when you lose internet connectivity.
          </p>
          <Link to="/plan">
            <Button variant="primary" size="md">
              Browse Routes
            </Button>
          </Link>
        </div>
      )}

      {/* Journeys List */}
      <div className="space-y-4">
        {savedJourneys.map((item) => {
          const savedDate = new Date(item.savedTimestamp);
          const formattedTime = savedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          return (
            <Card key={item.id} className="overflow-hidden">
              <CardContent className="p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-subtle-border pb-3">
                  <div>
                    <h3 className="font-heading font-bold text-lg text-ink">
                      {item.originName} → {item.destinationName}
                    </h3>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                      <span>Saved at {formattedTime} on {savedDate.toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(item.id)}
                      className="text-slate-400 hover:text-disruption hover:bg-rose-50 h-8 px-2"
                      title="Delete saved journey"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Staleness Warning as mandated in Section 13 */}
                <div className="p-2.5 rounded-lg bg-amber-50/70 border border-amber-200 text-[11px] text-warning flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Offline journey saved at {formattedTime}. Current lift and disruption information is unavailable.
                  </span>
                </div>

                {/* Key Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-400 block text-[10px]">Duration</span>
                    <strong className="text-ink">{Math.round(item.totalDurationMinutes)} min</strong>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-400 block text-[10px]">Fare</span>
                    <strong className="text-ink">{fareLabel(item.totalFareINR, item.fareStatus)}</strong>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-400 block text-[10px]">Walking</span>
                    <strong className="text-ink">{Math.round(item.walkingDistanceMeters)} m</strong>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-400 block text-[10px]">Dependent Lifts</span>
                    <strong className="text-ink">{item.dependentLifts.length > 0 ? item.dependentLifts.join(', ') : 'None'}</strong>
                  </div>
                </div>

                {/* Action */}
                <div className="flex justify-end pt-1">
                  <Link to={`/journey/${item.routeId}`}>
                    <Button size="sm" variant="outline" className="text-xs">
                      View Cached Navigation Itinerary
                      <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

