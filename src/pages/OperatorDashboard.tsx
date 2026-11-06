import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOperatorStore } from '../stores/operatorStore';
import { DEMO_SCENARIOS } from '../data/demoNetwork';
import { 
  ShieldAlert, 
  RotateCcw, 
  AlertTriangle, 
  Activity, 
  Building2, 
  CheckCircle2, 
  XCircle, 
  Radio, 
  BarChart2, 
  Plus, 
  X,
  Server,
  LogIn,
  LogOut,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { authService } from '../services/auth/cognito';
import { isDemoMode } from '../config/runtime';
import { DisruptionEvent } from '../types';
import { CommunityReportQueue } from '../components/reports/CommunityReportQueue';
import { SensorReliabilityLab } from '../components/operator/SensorReliabilityLab';
import { ACTIVE_LOCATIONS, LOCATION_GROUPS, getJourneyLocationName } from '../data/networkLocations';

function writeErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : '';
  return /unauthorized/i.test(message)
    ? 'Your operator session has expired. Sign in again and retry.'
    : message || 'The disruption could not be saved. Try again.';
}

export const OperatorDashboard: React.FC = () => {
  const {
    nodes,
    edges,
    facilities,
    disruptions,
    selectedScenarioId,
    applyScenario,
    resetDemo,
    resolveDisruption,
    createDisruption,
    isSimulating,
    loadError
  } = useOperatorStore();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [newDisruption, setNewDisruption] = useState({
    entityId: isDemoMode ? 'elev_a1' : ACTIVE_LOCATIONS[0]?.id ?? '',
    entityName: isDemoMode ? 'Elevator A1 (Platform 1-2 & Concourse)' : ACTIVE_LOCATIONS[0]?.name ?? '',
    stationName: isDemoMode ? 'Central Station' : undefined as string | undefined,
    type: 'elevator_outage' as DisruptionEvent['type'],
    severity: 'critical' as DisruptionEvent['severity'],
    reason: isDemoMode ? 'Routine sensor recalibration and maintenance' : '',
    affectedLinesOrStops: isDemoMode ? ['Central Station Metro Link'] : [],
    impactOnAccessibility: isDemoMode ? 'Wheelchair access requires alternate ramp.' : '',
  });

  const currentUser = authService.getCurrentUser();
  const isAuthenticated = authService.isAuthenticated();
  const operatorName = !isDemoMode && !isAuthenticated ? 'Operator sign-in required' : currentUser.name;
  const canWrite = isDemoMode || isAuthenticated;
  const activeDisruptions = disruptions.filter(d => d.isActive);
  const operationalLifts = facilities.filter(f => f.type === 'elevator' && f.operational).length;
  const unavailableLifts = facilities.filter(f => f.type === 'elevator' && !f.operational).length;
  const closedSegments = edges.filter(e => !e.isOperational).length;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsSaving(true);
    try {
      await createDisruption({
        ...newDisruption,
        effectiveStart: new Date().toISOString(),
        isActive: true,
      });
      setNewDisruption(current => ({ ...current, reason: '', impactOnAccessibility: '' }));
      setIsModalOpen(false);
    } catch (reason) {
      setFormError(writeErrorMessage(reason));
    } finally {
      setIsSaving(false);
    }
  };

  const handleResolve = async (id: string) => {
    setActionError(null);
    try {
      await resolveDisruption(id);
    } catch (reason) {
      setActionError(writeErrorMessage(reason));
    }
  };

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await authService.beginSignIn();
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : 'Operator sign-in could not start.');
    }
  };

  const metrics = isDemoMode ? [
    { label: 'Active disruptions', value: activeDisruptions.length, detail: 'Requiring attention', alert: activeDisruptions.length > 0 },
    { label: 'Operational lifts', value: operationalLifts, detail: 'Available across the network', alert: false },
    { label: 'Unavailable lifts', value: unavailableLifts, detail: 'Awaiting restoration', alert: unavailableLifts > 0 },
    { label: 'Closed segments', value: closedSegments, detail: 'Alternative route required', alert: closedSegments > 0 },
    { label: 'Accessibility coverage', value: '94.2%', detail: 'Demo audit coverage', alert: false },
  ] : [
    { label: 'Active disruptions', value: activeDisruptions.length, detail: 'Operator-reported events', alert: activeDisruptions.length > 0 },
    { label: 'Catalog locations', value: ACTIVE_LOCATIONS.length, detail: 'Chennai and SRM selection points', alert: false },
    { label: 'Tracked facilities', value: facilities.length, detail: 'Verified inventory not connected', alert: false },
    { label: 'Closed segments', value: activeDisruptions.filter(event => event.type === 'path_closure' || event.type === 'entrance_closure').length, detail: 'Active reported closures', alert: activeDisruptions.some(event => event.type === 'path_closure' || event.type === 'entrance_closure') },
    { label: 'Accessibility coverage', value: 'Not measured', detail: 'No physical audit claim', alert: false },
  ];

  return (
    <div className="product-page operator-page">
      <div data-reveal className="operator-heading">
        <div><h1 className="product-title">A clearer view of your network.</h1>
          <p className="product-description">Monitor access. Manage disruptions. Keep every journey moving.</p>
          <div className="operator-session"><span className="status-dot" /> {operatorName}<span className="session-divider" /><span>{isDemoMode ? 'Demo workspace' : 'AWS operator workspace'}</span></div>
        </div>
        <nav className="operator-actions" aria-label="Operator tools">
          <Link to="/operator/network" className="workspace-link"><Server size={15} /> Infrastructure</Link>
          <Link to="/operator/analytics" className="workspace-link"><BarChart2 size={15} /> Analytics</Link>
          {!isDemoMode && !isAuthenticated && (
            <Button size="sm" variant="operator" onClick={handleSignIn}>
              <LogIn size={14} /> Sign in with Cognito
            </Button>
          )}
          {!isDemoMode && isAuthenticated && (
            <Button size="sm" variant="outline" onClick={() => authService.signOut(true)}>
              <LogOut size={14} /> Sign out
            </Button>
          )}
          {isDemoMode && <Button size="sm" variant="outline" onClick={() => resetDemo()} isLoading={isSimulating}><RotateCcw size={14} /> Reset demo</Button>}
        </nav>
      </div>
      {authError && <div className="disruption-banner" role="alert">{authError}</div>}
      {loadError && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-800" role="alert">{loadError}</div>}
      {actionError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" role="alert">{actionError}</div>}
      <div data-reveal className="operator-metrics">
        {metrics.map(metric => <div key={metric.label} className="operator-metric"><span>{metric.label}</span><strong className={metric.alert ? 'text-disruption' : ''}>{metric.value}</strong><small>{metric.detail}</small></div>)}
      </div>
      {/* Hackathon Demo Scenario Presets */}
      {isDemoMode && <div data-reveal className="workspace-panel space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>

            <h2 className="font-heading font-medium text-xl text-ink">
              Explore a network scenario
            </h2>
            <p className="product-description">Test how the planner responds when access changes.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {DEMO_SCENARIOS.map((scenario) => {
            const isSelected = selectedScenarioId === scenario.id;
            return (
              <button
                type="button"
                aria-pressed={isSelected}
                disabled={isSimulating}
                key={scenario.id}
                onClick={() => applyScenario(scenario.id)}
                className={`scenario-option ${isSelected ? 'is-selected' : ''}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <span className="font-heading font-medium text-base text-ink">
                    {scenario.name.replace(/^Scenario \d+: /, '').replace(' (Hero Hackathon Demo)', '')}
                  </span>
                  {isSelected && (
                    <Badge variant="accent" className="bg-accent text-white border-transparent">Active</Badge>
                  )}
                </div>
                <span className="block text-sm text-ink-secondary leading-relaxed">
                  {scenario.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>}

      {/* Active Disruptions Management Panel */}
      <div data-reveal className="workspace-panel space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-disruption" />
            <h2 className="font-heading font-bold text-lg text-ink">
              Network disruptions <span className="text-ink-muted">({activeDisruptions.length})</span>
            </h2>
          </div>

          <Button
            size="sm"
            variant="operator"
            onClick={() => setIsModalOpen(true)}
            disabled={!canWrite}
            title={canWrite ? 'Report a disruption' : 'Operator sign-in is required'}
            className="text-xs"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Report disruption
          </Button>
          {!canWrite && <p className="w-full text-xs text-ink-secondary">Sign in with Cognito to report or resolve disruptions.</p>}
        </div>

        {activeDisruptions.length === 0 ? (
          <div className="network-empty">
            <CheckCircle2 className="w-8 h-8 text-accessible mx-auto mb-2" />
            <div>{isDemoMode
              ? 'No active disruptions on the demo network. All scenario facilities are operational.'
              : 'No active operator-reported disruptions. This does not confirm that every campus facility is operational.'}</div>
          </div>
        ) : (
          <div className="space-y-3">
            {activeDisruptions.map((disruption) => (
              <div
                key={disruption.id}
                className="p-4 rounded-xl bg-operator-card border border-rose-900/40 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-sm text-ink">{disruption.entityName}</span>
                    <Badge variant="disruption">{disruption.severity}</Badge>
                    <span className="text-ink-muted text-[11px]">{disruption.stationName}</span>
                  </div>
                  <p className="text-ink-secondary">{disruption.reason}</p>
                  <p className="text-disruption text-[11px] font-medium">Impact: {disruption.impactOnAccessibility}</p>
                </div>

                <div className="shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResolve(disruption.id)}
                    disabled={!canWrite}
                    className="border-emerald-600/40 text-accessible bg-accessible-subtle hover:bg-accessible-subtle text-xs"
                  >
                    Resolve & Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!isDemoMode && <CommunityReportQueue enabled={isAuthenticated} />}
      {!isDemoMode && <SensorReliabilityLab enabled={isAuthenticated} />}

      {/* Manual Report Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div role="dialog" aria-modal="true" aria-labelledby="report-heading" onKeyDown={(event) => { if (event.key === 'Escape') setIsModalOpen(false); }} className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-operator-surface rounded-2xl border border-operator-border p-6 space-y-4 text-operator-ink shadow-floating">
            <div className="flex items-center justify-between border-b border-operator-border pb-3">
              <h3 id="report-heading" className="font-heading font-bold text-lg text-ink">
                Report a disruption
              </h3>
              <button aria-label="Close disruption report" onClick={() => setIsModalOpen(false)} className="text-ink-muted hover:text-ink">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-3 text-xs">
              <div>
                <label htmlFor="disruption-location" className="block text-ink-muted mb-1">{isDemoMode ? 'Affected facility' : 'Affected location'}</label>
                <select
                  id="disruption-location"
                  value={newDisruption.entityId}
                  onChange={(e) => {
                    const facility = facilities.find(item => item.id === e.target.value);
                    setNewDisruption({
                      ...newDisruption,
                      entityId: e.target.value,
                      entityName: facility ? facility.name : getJourneyLocationName(e.target.value),
                      stationName: facility ? facility.stationName : undefined,
                    });
                  }}
                  className="w-full p-2.5 rounded-lg bg-operator-bg border border-operator-border text-ink text-xs"
                >
                  {isDemoMode
                    ? facilities.map(fac => <option key={fac.id} value={fac.id}>{fac.name} &mdash; {fac.stationName}</option>)
                    : LOCATION_GROUPS.map(group => (
                        <optgroup key={group.label} label={group.label}>
                          {group.locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
                        </optgroup>
                      ))}
                </select>
              </div>

              {!isDemoMode && (
                <div>
                  <label htmlFor="disruption-type" className="block text-ink-muted mb-1">Disruption type</label>
                  <select
                    id="disruption-type"
                    value={newDisruption.type}
                    onChange={(e) => setNewDisruption({
                      ...newDisruption,
                      type: e.target.value as DisruptionEvent['type'],
                    })}
                    className="w-full p-2.5 rounded-lg bg-operator-bg border border-operator-border text-ink text-xs"
                  >
                    <option value="elevator_outage">Elevator outage</option>
                    <option value="path_closure">Path closure</option>
                    <option value="entrance_closure">Entrance closure</option>
                    <option value="service_delay">Service delay</option>
                    <option value="bus_cancellation">Bus cancellation</option>
                  </select>
                </div>
              )}

              <div>
                <label htmlFor="disruption-reason" className="block text-ink-muted mb-1">What happened?</label>
                <input
                  id="disruption-reason"
                  type="text"
                  value={newDisruption.reason}
                  onChange={(e) => setNewDisruption({ ...newDisruption, reason: e.target.value })}
                  className="w-full p-2.5 rounded-lg bg-operator-bg border border-operator-border text-ink text-xs"
                  required
                />
              </div>

              <div>
                <label htmlFor="disruption-impact" className="block text-ink-muted mb-1">How does this affect travellers?</label>
                <textarea
                  id="disruption-impact"
                  value={newDisruption.impactOnAccessibility}
                  onChange={(e) => setNewDisruption({ ...newDisruption, impactOnAccessibility: e.target.value })}
                  className="w-full p-2.5 rounded-lg bg-operator-bg border border-operator-border text-ink text-xs h-20"
                  required
                />
              </div>

              {formError && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-rose-800">{formError}</div>}

              <div className="flex justify-end gap-2 pt-2 border-t border-operator-border">
                <Button type="button" size="sm" variant="ghost" onClick={() => setIsModalOpen(false)} className="text-ink-muted hover:text-ink">
                  Cancel
                </Button>
                <Button size="sm" variant="danger" type="submit" isLoading={isSaving} disabled={isSaving}>
                  Publish disruption
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

