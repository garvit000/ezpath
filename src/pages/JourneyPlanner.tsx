import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useJourneyStore, getStationName } from '../stores/journeyStore';
import { SearchControls } from '../components/journey/SearchControls';
import { RouteCard } from '../components/journey/RouteCard';
import { InteractiveMap } from '../components/maps/InteractiveMap';
import { DisruptionBanner } from '../components/disruptions/DisruptionBanner';
import { WhatChangedDiff } from '../components/journey/WhatChangedDiff';
import { ConstraintInspector } from '../components/accessibility/ConstraintInspector';
import { RouteComparison } from '../components/journey/RouteComparison';
import { saveJourney } from '../services/offline/idbStorage';
import { 
  PanelLeftClose, 
  PanelLeftOpen, 
  PanelRightClose, 
  PanelRightOpen, 
  Scale, 
  Bookmark, 
  Check, 
  Compass, 
  AlertCircle,
  Map as MapIcon,
  Sliders,
  ListFilter,
  X,
  ChevronUp
} from 'lucide-react';
import { Button } from '../components/ui/Button';

export const JourneyPlanner: React.FC = () => {
  const navigate = useNavigate();
  const {
    originId,
    destinationId,
    routes,
    selectedRouteId,
    decision,
    setSelectedRouteId,
    searchJourneys,
    isLoading,
    error,
    isConstraintInspectorOpen,
    setConstraintInspectorOpen,
    isComparisonModalOpen,
    setComparisonModalOpen,
  } = useJourneyStore();

  // Desktop floating panels
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Mobile drawer mode: 'map' | 'plan' | 'routes'
  const [mobileTab, setMobileTab] = useState<'map' | 'plan' | 'routes'>('map');
  const [savedRouteId, setSavedRouteId] = useState<string | null>(null);

  // Automatically perform initial search on mount
  useEffect(() => {
    if (routes.length === 0) {
      searchJourneys();
    }
  }, []);

  const selectedRoute = routes.find(r => r.id === selectedRouteId) ||
    (decision && decision.status !== 'READY' ? null : routes[0]) || null;
  const affectedRouteIds = new Set(decision?.status === 'READY' ? []
    : decision?.missingFacts.flatMap((fact) => fact.affectedRouteIds) ?? []);
  const selectedNeedsConfirmation = selectedRoute ? affectedRouteIds.has(selectedRoute.id) : false;

  const handleSaveCurrentJourney = async () => {
    if (!selectedRoute) return;
    try {
      await saveJourney(
        selectedRoute, 
        getStationName(originId), 
        getStationName(destinationId)
      );
      setSavedRouteId(selectedRoute.id);
      setTimeout(() => setSavedRouteId(null), 3000);
    } catch {
      // IndexedDB save handling
    }
  };

  return (
    <div className="relative w-full flex-1 h-[calc(100vh-78px)] min-h-[500px] overflow-hidden bg-slate-100">
      {/* 1. FULL-PAGE EDGE-TO-EDGE MAP (Always rendered underneath) */}
      <div className="absolute inset-0 w-full h-full z-0">
        <InteractiveMap
          routes={routes}
          selectedRouteId={selectedRouteId}
          onSelectRoute={(id) => setSelectedRouteId(id)}
          className="w-full h-full"
        />
      </div>

      {/* 2. DESKTOP FLOATING PANELS LAYER (Hidden on mobile < lg) */}
      <div className="hidden lg:flex absolute inset-0 z-10 pointer-events-none p-5 justify-between items-start gap-4 overflow-hidden">
        {/* Desktop Left Floating Panel — Requirements */}
        {leftOpen ? (
          <aside 
            aria-label="Journey Planning Controls"
            className="pointer-events-auto w-[370px] max-h-[calc(100vh-120px)] bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-floating flex flex-col overflow-hidden animate-in fade-in slide-in-from-left-4 duration-200"
          >
            <div className="p-3.5 border-b border-subtle-border flex items-center justify-between bg-slate-50/70">
              <span className="font-heading font-bold text-sm text-ink flex items-center gap-2">
                <Compass className="w-4 h-4 text-accent" />
                Journey Requirements
              </span>
              <button
                onClick={() => setLeftOpen(false)}
                className="p-1 rounded-md text-slate-400 hover:text-ink hover:bg-slate-200 transition-colors"
                aria-label="Collapse search panel"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <SearchControls />
            </div>
          </aside>
        ) : (
          <button
            onClick={() => setLeftOpen(true)}
            aria-label="Expand journey controls"
            className="pointer-events-auto p-2.5 px-3.5 bg-white/95 backdrop-blur-md rounded-xl border border-slate-200 shadow-floating text-ink hover:text-accent hover:scale-105 transition-all flex items-center gap-2 text-xs font-semibold"
          >
            <PanelLeftOpen className="w-4 h-4 text-accent" />
            <span>Requirements</span>
          </button>
        )}

        {/* Desktop Right Floating Panel — Results */}
        {rightOpen ? (
          <aside
            aria-label="Route Results and Inspection"
            className="pointer-events-auto w-[390px] max-h-[calc(100vh-120px)] bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-floating flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-4 duration-200"
          >
            <div className="p-3.5 border-b border-subtle-border flex items-center justify-between bg-slate-50/70">
              <span className="font-heading font-bold text-sm text-ink">
                Route Alternatives ({routes.length})
              </span>

              <div className="flex items-center gap-1.5">
                {routes.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setComparisonModalOpen(true)}
                    className="h-7 text-xs px-2 gap-1 border-slate-300 bg-white"
                    title="Compare route tradeoffs"
                  >
                    <Scale className="w-3.5 h-3.5" />
                    Compare
                  </Button>
                )}

                <button
                  onClick={() => setRightOpen(false)}
                  className="p-1 rounded-md text-slate-400 hover:text-ink hover:bg-slate-200 transition-colors"
                  aria-label="Collapse results panel"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <DisruptionBanner />
              <WhatChangedDiff />

              {isLoading && (
                <div className="space-y-3 py-6 text-center">
                  <div className="inline-block animate-spin w-8 h-8 border-4 border-accent border-t-transparent rounded-full mb-2" />
                  <div className="text-xs font-semibold text-ink">Finding your routes</div>
                  <div className="text-[11px] text-slate-500">Checking timetables, walking limits and reported disruptions</div>
                </div>
              )}

              {error && (
                <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-ink space-y-2">
                  <div className="flex items-center gap-1.5 font-bold text-disruption">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>No route found</span>
                  </div>
                  <p className="text-slate-600 leading-relaxed">{error}</p>
                </div>
              )}

              {!isLoading && routes.length > 0 && (
                <div className="space-y-3">
                  {routes.map((route) => (
                    <RouteCard
                      key={route.id}
                      route={route}
                      confirmationRequired={affectedRouteIds.has(route.id)}
                      isSelected={route.id === selectedRouteId}
                      onSelect={() => setSelectedRouteId(route.id)}
                      onOpenInspector={() => setConstraintInspectorOpen(true)}
                      onViewDetails={affectedRouteIds.has(route.id) ? undefined : () => navigate(`/journey/${route.id}`)}
                    />
                  ))}
                </div>
              )}

              {selectedRoute && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="text-xs font-semibold text-slate-600">
                    Selected Route Actions
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSaveCurrentJourney}
                      className="w-full text-xs font-medium bg-white"
                    >
                      {savedRouteId === selectedRoute.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 mr-1 text-accessible" />
                          Saved
                        </>
                      ) : (
                        <>
                          <Bookmark className="w-3.5 h-3.5 mr-1 text-accent" />
                          Save Offline
                        </>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => navigate(`/journey/${selectedRoute.id}`)}
                      className="w-full text-xs font-semibold"
                    >
                      Start Itinerary
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        ) : (
          <button
            onClick={() => setRightOpen(true)}
            aria-label="Expand results panel"
            className="pointer-events-auto p-2.5 px-3.5 bg-white/95 backdrop-blur-md rounded-xl border border-slate-200 shadow-floating text-ink hover:text-accent hover:scale-105 transition-all flex items-center gap-2 text-xs font-semibold"
          >
            <PanelRightOpen className="w-4 h-4 text-accent" />
            <span>Routes ({routes.length})</span>
          </button>
        )}
      </div>

      {/* 3. MOBILE INTERACTIVE DRAWERS & CONTROLS (< lg) */}
      <div className="lg:hidden">
        {/* Mobile Floating Bottom Bar when viewing Map */}
        {mobileTab === 'map' && (
          <div className="fixed bottom-4 left-3 right-3 z-30 flex items-center gap-2 p-2 bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-floating animate-in slide-in-from-bottom-3 duration-200">
            <button
              onClick={() => setMobileTab('plan')}
              className="flex-1 min-h-[44px] py-2.5 px-3 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-ink rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <Sliders className="w-4 h-4 text-accent" />
              <span>Filter / Plan</span>
            </button>

            <button
              onClick={() => setMobileTab('routes')}
              className="flex-1 min-h-[44px] py-2.5 px-3 bg-accent active:bg-accent/90 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-2 shadow-sm transition-colors"
            >
              <ListFilter className="w-4 h-4" />
              <span>Routes ({routes.length})</span>
              {selectedRoute && (
                <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full font-mono">
                  {selectedRoute.totalDurationMinutes}m
                </span>
              )}
            </button>
          </div>
        )}

        {/* Mobile Slide-up Sheet: Journey Requirements ('plan') */}
        {mobileTab === 'plan' && (
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-200">
            <div className="w-full max-h-[85vh] bg-white rounded-t-3xl shadow-floating border-t border-slate-200 flex flex-col overflow-hidden animate-in slide-in-from-bottom-6 duration-300">
              {/* Sheet Header with Close Button */}
              <div className="p-4 border-b border-subtle-border flex items-center justify-between bg-slate-50/90">
                <div className="flex items-center gap-2">
                  <Compass className="w-4 h-4 text-accent" />
                  <span className="font-heading font-bold text-sm text-ink">
                    Journey Requirements
                  </span>
                </div>
                <button
                  onClick={() => setMobileTab('map')}
                  className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-full bg-slate-100 active:bg-slate-200 text-slate-500 hover:text-ink transition-colors"
                  aria-label="Close sheet and show map"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Form Scroll Area */}
              <div className="flex-1 overflow-y-auto p-2 pb-6">
                <SearchControls onSearch={() => setMobileTab('routes')} />
              </div>
            </div>
          </div>
        )}

        {/* Mobile Slide-up Sheet: Route Alternatives ('routes') */}
        {mobileTab === 'routes' && (
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-200">
            <div className="w-full max-h-[85vh] bg-white rounded-t-3xl shadow-floating border-t border-slate-200 flex flex-col overflow-hidden animate-in slide-in-from-bottom-6 duration-300">
              {/* Sheet Header */}
              <div className="p-4 border-b border-subtle-border flex items-center justify-between bg-slate-50/90">
                <div>
                  <span className="font-heading font-bold text-sm text-ink">
                    Route Alternatives ({routes.length})
                  </span>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Select a route to highlight on the map
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {routes.length > 1 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setComparisonModalOpen(true)}
                      className="h-8 text-xs px-2.5 bg-white border-slate-300"
                    >
                      <Scale className="w-3.5 h-3.5 mr-1" />
                      Compare
                    </Button>
                  )}
                  <button
                    onClick={() => setMobileTab('map')}
                    className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-full bg-slate-100 active:bg-slate-200 text-slate-500 hover:text-ink transition-colors"
                    aria-label="Close sheet and show map"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Results Scroll Area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-8">
                <DisruptionBanner />
                <WhatChangedDiff />

                {isLoading && (
                  <div className="space-y-3 py-6 text-center">
                    <div className="inline-block animate-spin w-8 h-8 border-4 border-accent border-t-transparent rounded-full mb-2" />
                    <div className="text-xs font-semibold text-ink">Evaluating Multimodal Network...</div>
                  </div>
                )}

                {error && (
                  <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-ink space-y-2">
                    <div className="flex items-center gap-1.5 font-bold text-disruption">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>No Feasible Accessible Route</span>
                    </div>
                    <p className="text-slate-600 leading-relaxed">{error}</p>
                  </div>
                )}

                {!isLoading && routes.length > 0 && (
                  <div className="space-y-3">
                    {routes.map((route) => (
                      <div key={route.id} className="space-y-2">
                        <RouteCard
                          route={route}
                          isSelected={route.id === selectedRouteId}
                          onSelect={() => {
                            setSelectedRouteId(route.id);
                            // On mobile, tapping route selects it and allows switching back to map
                          }}
                          onOpenInspector={() => setConstraintInspectorOpen(true)}
                          onViewDetails={() => navigate(`/journey/${route.id}`)}
                        />
                        {route.id === selectedRouteId && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setMobileTab('map')}
                            className="w-full text-xs font-semibold py-2"
                          >
                            <MapIcon className="w-3.5 h-3.5 mr-1.5" />
                            View This Route on Map
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {selectedRoute && (
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                    <div className="text-xs font-semibold text-slate-600">
                      Selected Route Actions
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveCurrentJourney}
                        className="w-full text-xs font-medium bg-white"
                      >
                        {savedRouteId === selectedRoute.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 mr-1 text-accessible" />
                            Saved
                          </>
                        ) : (
                          <>
                            <Bookmark className="w-3.5 h-3.5 mr-1 text-accent" />
                            Save Offline
                          </>
                        )}
                      </Button>

                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => navigate(`/journey/${selectedRoute.id}`)}
                        className="w-full text-xs font-semibold"
                      >
                        Start Itinerary
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Signature Feature: Constraint Inspector Modal */}
      <ConstraintInspector
        route={selectedRoute}
        isOpen={isConstraintInspectorOpen}
        onClose={() => setConstraintInspectorOpen(false)}
      />

      {/* Route Tradeoff Comparison Modal */}
      <RouteComparison
        routes={routes}
        isOpen={isComparisonModalOpen}
        onClose={() => setComparisonModalOpen(false)}
        onSelectRoute={(id) => setSelectedRouteId(id)}
        selectedRouteId={selectedRouteId}
      />
    </div>
  );
};
