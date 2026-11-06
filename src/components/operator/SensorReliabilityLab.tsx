import { useEffect, useState } from 'react';
import { authService } from '../../services/auth/cognito';

type Scenario = 'healthy' | 'outage' | 'missing' | 'delayed' | 'spike' | 'frozen' | 'fluctuating' | 'disagree';
type Assessment = {
  facilityId: string;
  quality: 'TRUSTED' | 'SUSPECT' | 'CONFLICTING' | 'UNKNOWN';
  effectiveState: 'OPERATIONAL' | 'OUTAGE' | 'UNKNOWN';
  flags: string[];
  simulated: true;
  scenario?: Scenario | null;
  operatorConfirmation?: { state: 'OPERATIONAL' | 'OUTAGE'; confirmedAt: string; expiresAt: number } | null;
};

const scenarios: Array<{ id: Scenario; label: string; detail: string }> = [
  { id: 'healthy', label: 'Normal readings', detail: 'Two sources agree the lift is working.' },
  { id: 'outage', label: 'Outage readings', detail: 'Two sources agree the lift is unavailable.' },
  { id: 'missing', label: 'Missing readings', detail: 'No sensor heartbeat is available.' },
  { id: 'delayed', label: 'Delayed reading', detail: 'The latest reading is older than two minutes.' },
  { id: 'spike', label: 'One reading spike', detail: 'A single outage appears after two normal readings.' },
  { id: 'frozen', label: 'Frozen sequence', detail: 'The sequence number stops advancing.' },
  { id: 'fluctuating', label: 'Fluctuating readings', detail: 'The lift rapidly changes state.' },
  { id: 'disagree', label: 'Sources disagree', detail: 'Two sources report different states.' },
];

const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export function SensorReliabilityLab({ enabled }: { enabled: boolean }) {
  const [selected, setSelected] = useState<Scenario>('missing');
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedState, setConfirmedState] = useState<'OPERATIONAL' | 'OUTAGE'>('OPERATIONAL');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const refresh = async () => {
    const response = await fetch(`${baseUrl}/v1/telemetry/evidence`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not load sensor evidence.');
    setAssessment(data as Assessment);
  };

  useEffect(() => {
    if (!baseUrl) return;
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load sensor evidence.'));
  }, []);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const token = authService.getAccessToken();
      if (!token) throw new Error('Operator sign-in is required to run the simulator.');
      const response = await fetch(`${baseUrl}/v1/telemetry/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ facilityId: 'rail-potheri', scenario: selected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Simulation could not be saved.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Simulation failed.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      const token = authService.getAccessToken();
      if (!token) throw new Error('Operator sign-in is required.');
      const response = await fetch(`${baseUrl}/v1/telemetry/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ facilityId: 'rail-potheri', state: confirmedState,
          note: note.trim(), verifiedFromRealWorld: acknowledged }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Confirmation could not be saved.');
      setNote('');
      setAcknowledged(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Confirmation failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace-panel space-y-4" aria-labelledby="sensor-lab-heading">
      <div>
        <h2 id="sensor-lab-heading" className="font-heading font-bold text-lg text-ink">Potheri lift sensor simulator</h2>
        <p className="text-sm text-ink-secondary">Training data only. No physical sensor is connected, and these readings never verify real lift or boarding access.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor="sensor-scenario" className="block text-sm font-medium text-ink mb-1">Reading scenario</label>
          <select id="sensor-scenario" value={selected} onChange={(event) => setSelected(event.target.value as Scenario)}
            className="w-full rounded-lg border border-operator-border bg-operator-bg p-2.5 text-sm text-ink">
            {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-secondary">{scenarios.find((scenario) => scenario.id === selected)?.detail}</p>
        </div>
        <button type="button" onClick={run} disabled={!enabled || busy || !baseUrl}
          className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Running…' : 'Run simulation'}
        </button>
      </div>
      {!enabled && <p className="text-xs text-ink-secondary">Sign in as an operator to run a scenario.</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {assessment && <div role="status" aria-live="polite" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-800">
        <p><strong>Evidence:</strong> {assessment.quality.toLowerCase()} · <strong>Reading:</strong> {assessment.effectiveState.toLowerCase()}</p>
        <p><strong>Scenario:</strong> {assessment.scenario ? scenarios.find((item) => item.id === assessment.scenario)?.label : 'No run yet'}</p>
        <p><strong>Checks:</strong> {assessment.flags.length ? assessment.flags.map((flag) => flag.replace(/_/g, ' ').toLowerCase()).join(', ') : 'No anomaly detected'}</p>
        <p className="mt-2">For routes that rely on the Potheri lift, the planner asks for real-world confirmation before recommending an itinerary.</p>
      </div>}
      <div className="border-t border-operator-border pt-4 space-y-3">
        <h3 className="font-heading font-semibold text-base text-ink">Confirm the real lift status</h3>
        <p className="text-sm text-ink-secondary">Use only after checking with station staff or inspecting the lift. This confirmation expires after 15 minutes. Boarding access remains unverified.</p>
        {assessment?.operatorConfirmation && <p role="status" className="text-sm text-ink">Current operator confirmation: <strong>{assessment.operatorConfirmation.state.toLowerCase()}</strong>, recorded {new Date(assessment.operatorConfirmation.confirmedAt).toLocaleString()}.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="confirmed-lift-state" className="block text-sm font-medium text-ink mb-1">Verified lift state</label>
            <select id="confirmed-lift-state" value={confirmedState} onChange={(event) => setConfirmedState(event.target.value as 'OPERATIONAL' | 'OUTAGE')}
              className="w-full rounded-lg border border-operator-border bg-operator-bg p-2.5 text-sm text-ink">
              <option value="OPERATIONAL">Operational</option><option value="OUTAGE">Outage</option>
            </select>
          </div>
          <div>
            <label htmlFor="confirmation-note" className="block text-sm font-medium text-ink mb-1">How was it checked?</label>
            <input id="confirmation-note" type="text" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)}
              placeholder="Station staff call or on-site check" className="w-full rounded-lg border border-operator-border bg-operator-bg p-2.5 text-sm text-ink" />
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" />
          I checked a real-world source; I am not relying on the simulator.
        </label>
        <button type="button" onClick={confirm} disabled={!enabled || busy || !baseUrl || !note.trim() || !acknowledged}
          className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Saving…' : 'Save 15-minute confirmation'}
        </button>
      </div>
    </section>
  );
}
