import React from 'react';
import { fareLabel } from '../../utils/fare';
import { JourneyRoute } from '../../types';
import { 
  X, 
  Scale, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  IndianRupee, 
  Footprints,
  ShieldCheck,
  TrendingUp
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';

interface RouteComparisonProps {
  routes: JourneyRoute[];
  isOpen: boolean;
  onClose: () => void;
  onSelectRoute: (id: string) => void;
  selectedRouteId: string | null;
}

export const RouteComparison: React.FC<RouteComparisonProps> = ({
  routes,
  isOpen,
  onClose,
  onSelectRoute,
  selectedRouteId
}) => {
  if (!isOpen || routes.length === 0) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/50 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="comparison-dialog-title"
    >
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-floating border border-subtle-border overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="p-5 border-b border-subtle-border bg-slate-50/70 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-subtle border border-blue-200 text-accent flex items-center justify-center shrink-0">
              <Scale className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs font-semibold text-accent uppercase tracking-wider">
                Multimodal Alternative Evaluation
              </div>
              <h2 id="comparison-dialog-title" className="font-heading font-extrabold text-lg text-ink">
                Route Tradeoff Comparison
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-ink hover:bg-slate-200 transition-colors"
            aria-label="Close comparison"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Table */}
        <div className="p-6 overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-subtle-border">
                <th className="py-3 px-4 font-semibold text-slate-500 uppercase tracking-wider w-1/4">
                  Evaluation Metric
                </th>
                {routes.map((route, i) => (
                  <th key={route.id} className="py-3 px-4 font-bold text-ink">
                    <div className="flex items-center justify-between gap-2">
                      <span>{route.label || `Route ${i + 1}`}</span>
                      {route.id === selectedRouteId && (
                        <Badge variant="accent">Selected</Badge>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle-border">
              {/* Duration */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-accent" /> Total Duration
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4 font-heading font-bold text-sm text-ink">
                    {Math.round(route.totalDurationMinutes)} min
                  </td>
                ))}
              </tr>

              {/* Fare */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <IndianRupee className="w-4 h-4 text-emerald-600" /> Total Fare
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4 font-heading font-bold text-sm text-ink">
                    {fareLabel(route.totalFareINR, route.fareStatus)}
                  </td>
                ))}
              </tr>

              {/* Walking */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <Footprints className="w-4 h-4 text-indigo-500" /> Walking Distance
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4 font-semibold text-ink">
                    {Math.round(route.walkingDistanceMeters)} m
                  </td>
                ))}
              </tr>

              {/* Transfers */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <span className="font-bold">⇌</span> Vehicle Transfers
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4 font-semibold text-ink">
                    {route.transfersCount} {route.transfersCount === 1 ? 'transfer' : 'transfers'}
                  </td>
                ))}
              </tr>

              {/* Accessibility */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-accessible" /> Accessibility Status
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4">
                    {(route.accessibilityStatus ?? (route.isStepFree ? 'verified' : 'inaccessible')) === 'verified' ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-accessible">
                        <CheckCircle2 className="w-4 h-4" /> {route.accessibilityStatus ? 'Tag-supported' : 'Verified Step-free'}
                      </span>
                    ) : route.accessibilityStatus === 'uncertain' ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-warning">
                        <AlertTriangle className="w-4 h-4" /> Unverified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-semibold text-disruption">
                        <AlertTriangle className="w-4 h-4" /> Contains Stairs
                      </span>
                    )}
                  </td>
                ))}
              </tr>

              {/* Reliability */}
              <tr className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium text-slate-600 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-accent" /> Reliability Confidence
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-3 px-4 font-semibold text-ink">
                    {route.reliabilityScore === null ? 'Not measured' : `${route.reliabilityScore}% verified`}
                  </td>
                ))}
              </tr>

              {/* Action row */}
              <tr>
                <td className="py-4 px-4 font-medium text-slate-500">
                  Select This Route
                </td>
                {routes.map(route => (
                  <td key={route.id} className="py-4 px-4">
                    <Button
                      size="sm"
                      variant={route.id === selectedRouteId ? 'secondary' : 'outline'}
                      onClick={() => {
                        onSelectRoute(route.id);
                        onClose();
                      }}
                      className="w-full text-xs"
                    >
                      {route.id === selectedRouteId ? 'Active Selection' : 'Choose Route'}
                    </Button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-subtle-border bg-slate-50 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};

