import React from 'react';
import { RouteLeg } from '../../types';
import { 
  Footprints, 
  Bus, 
  Train, 
  ArrowDown, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Database,
  Building2
} from 'lucide-react';
import { Badge } from '../ui/Badge';

interface ItineraryTimelineProps {
  legs: RouteLeg[];
}

export const ItineraryTimeline: React.FC<ItineraryTimelineProps> = ({ legs }) => {
  return (
    <div className="space-y-4" role="list" aria-label="Step-by-step turn-by-turn itinerary">
      {legs.map((leg, index) => {
        const isTransit = leg.legType === 'bus' || leg.legType === 'train';
        const isElevator = leg.legType === 'elevator';
        const isStairs = leg.legType === 'stairs';
        const isRamp = leg.legType === 'ramp';

        return (
          <div key={leg.id} data-reveal className="relative flex items-start gap-3 text-xs" role="listitem">
            {/* Timeline line */}
            {index < legs.length - 1 && (
              <div className="absolute top-7 left-3.5 -bottom-5 w-0.5 bg-subtle-border" />
            )}

            {/* Icon */}
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 text-white shadow-sm ${
              isStairs ? 'bg-disruption ring-2 ring-rose-200' :
              isElevator ? 'bg-accent ring-2 ring-accent/15' :
              isTransit ? 'bg-accent ring-2 ring-accent/15' :
              isRamp ? 'bg-accessible ring-2 ring-accessible/15' :
              'bg-slate-600 ring-2 ring-slate-200'
            }`}>
              {isTransit ? (leg.legType === 'bus' ? <Bus className="w-3.5 h-3.5" /> : <Train className="w-3.5 h-3.5" />) :
               isElevator ? <Building2 className="w-3.5 h-3.5" /> :
               <Footprints className="w-3.5 h-3.5" />}
            </div>

            {/* Leg Details */}
            <div className="flex-1 min-w-0 pb-6 border-b border-subtle-border space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-heading font-medium text-sm text-ink">
                    {leg.lineName || `${leg.fromNodeName} → ${leg.toNodeName}`}
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    {leg.fromNodeName} to {leg.toNodeName}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <span className="font-bold text-ink">{Math.max(1, Math.round(leg.durationMinutes))} min</span>
                  <div className="text-[10px] text-ink-muted">{Math.round(leg.distanceMeters)} m</div>
                </div>
              </div>

              {/* Step instructions */}
              {leg.steps.map((step, sIdx) => (
                <div key={sIdx} className="text-xs leading-relaxed text-ink-secondary bg-accent-subtle/50 p-3 rounded-md flex flex-col sm:flex-row items-start justify-between gap-2">
                  <span>{step.instruction}</span>
                  {step.stepFree ? (
                    <span className="text-[10px] font-semibold text-accessible shrink-0 flex items-center gap-0.5">
                      <CheckCircle2 className="w-3 h-3" /> Step-free
                    </span>
                  ) : step.accessUnknown ? (
                    <span className="text-[10px] font-semibold text-warning shrink-0 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" /> Access unverified
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold text-disruption shrink-0 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" /> Stairs
                    </span>
                  )}
                </div>
              ))}

              {/* Audit / Telemetry evidence */}
              <div className="flex flex-wrap gap-2 items-center justify-between text-[10px] text-ink-muted pt-1 border-t border-slate-100">
                <span className="flex items-center gap-1">
                  <Database className="w-3 h-3" /> {leg.evidenceSource.replace(/_/g, ' ')}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {new Date(leg.evidenceTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

