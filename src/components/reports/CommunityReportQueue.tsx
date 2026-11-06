import React, { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardCheck, X } from 'lucide-react';
import { CommunityReport, REPORT_ISSUES } from '../../types';
import { reportsClient } from '../../services/api/reportsClient';
import { useOperatorStore } from '../../stores/operatorStore';
import { Button } from '../ui/Button';

export const CommunityReportQueue: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const [reports, setReports] = useState<CommunityReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createDisruption = useOperatorStore(state => state.createDisruption);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setReports(await reportsClient.listPending());
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reports could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void load(); }, [load]);

  const review = async (report: CommunityReport, action: 'verify' | 'reject') => {
    setActionId(report.reportId);
    setError(null);
    try {
      if (action === 'verify') {
        const issue = REPORT_ISSUES.find(item => item.id === report.issueType);
        const type = issue?.eventType ?? 'service_delay';
        await createDisruption({
          entityId: report.locationId,
          entityName: report.locationName,
          type,
          severity: type === 'service_delay' ? 'warning' : 'critical',
          reason: report.description,
          effectiveStart: new Date().toISOString(),
          affectedLinesOrStops: [],
          impactOnAccessibility: `${issue?.label ?? 'Issue'} reported by a traveller and confirmed by an operator.`,
          isActive: true,
        });
      }
      await reportsClient.review(report.reportId, action);
      setReports(current => current.filter(item => item.reportId !== report.reportId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The report could not be reviewed.');
    } finally {
      setActionId(null);
    }
  };

  return <section data-reveal className="workspace-panel space-y-5" aria-labelledby="community-reports-heading">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="community-reports-heading" className="flex items-center gap-2 font-heading text-lg font-bold text-ink"><ClipboardCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" /> Traveller reports <span className="text-ink-muted">({reports.length})</span></h2>
        <p className="product-description">Confirming a report publishes a disruption, alerts travellers and reroutes journeys.</p>
      </div>
      {enabled && <Button size="sm" variant="outline" onClick={load} isLoading={loading}>Refresh</Button>}
    </div>
    {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
    {!enabled ? <div className="network-empty">Sign in to view and review traveller reports.</div>
      : loaded && reports.length === 0 ? <div className="network-empty">No reports are waiting for review.</div>
      : <div className="grid gap-4 lg:grid-cols-2">{reports.map(report => <article key={report.reportId} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {report.photoUrl && <img src={report.photoUrl} alt={`Submitted evidence for ${report.locationName}`} className="h-52 w-full bg-slate-100 object-cover" />}
          <div className="space-y-3 p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800">{REPORT_ISSUES.find(item => item.id === report.issueType)?.label ?? 'Access issue'}</p>
              <h3 className="font-semibold text-slate-900">{report.locationName}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{report.description}</p>
            </div>
            <p className="text-xs text-slate-500">Submitted {new Date(report.submittedAt ?? report.createdAt).toLocaleString()}</p>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
              <Button size="sm" variant="outline" disabled={actionId === report.reportId} onClick={() => review(report, 'reject')}><X size={14} aria-hidden="true" /> Reject</Button>
              <Button size="sm" variant="operator" disabled={actionId === report.reportId} isLoading={actionId === report.reportId} onClick={() => review(report, 'verify')}><Check size={14} aria-hidden="true" /> Confirm and publish</Button>
            </div>
          </div>
        </article>)}</div>}
  </section>;
};
