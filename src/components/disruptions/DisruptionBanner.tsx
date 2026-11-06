import React from 'react';
import { useJourneyStore } from '../../stores/journeyStore';
import { AlertTriangle, RefreshCw, ShieldAlert, ArrowRight } from 'lucide-react';
import { Button } from '../ui/Button';

export const DisruptionBanner: React.FC = () => {
  const { 
    activeDisruptionAlert, 
    replanJourney, 
    isReplanning 
  } = useJourneyStore();

  if (!activeDisruptionAlert) return null;

  return (
    <div 
      role="alert" 
      aria-live="assertive"
      className="p-4 rounded-xl bg-rose-50 border-2 border-disruption text-ink shadow-floating animate-in slide-in-from-top-4 duration-300"
    >
      <div className="flex flex-col items-stretch gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-disruption text-white shrink-0 shadow-sm animate-pulse">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-heading font-extrabold text-sm text-disruption uppercase tracking-wider">
                Live Disruption Alert
              </span>
              <span className="text-[11px] font-semibold bg-rose-200/80 text-disruption px-2 py-0.5 rounded-full">
                Active Outage
              </span>
            </div>
            <h3 className="font-heading font-bold text-base text-ink">
              Your journey has been affected.
            </h3>
            <p className="text-xs text-slate-700 leading-relaxed max-w-xl">
              <strong>{activeDisruptionAlert.entityName}</strong>{activeDisruptionAlert.stationName && activeDisruptionAlert.stationName !== activeDisruptionAlert.entityName ? ` at ${activeDisruptionAlert.stationName}` : ''} is reported as affected ({activeDisruptionAlert.reason}).
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full">
          <Button
            variant="danger"
            size="md"
            onClick={() => replanJourney()}
            isLoading={isReplanning}
            className="w-full font-semibold text-xs shadow-md"
          >
            <RefreshCw className="w-4 h-4 mr-1.5" />
            Recalculate Accessible Route
          </Button>
        </div>
      </div>
    </div>
  );
};

