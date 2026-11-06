import React from 'react';
import { JourneyRoute } from '../../types';
import { 
  Clock, 
  Footprints, 
  ArrowRight, 
  CheckCircle2, 
  AlertTriangle, 
  HelpCircle, 
  Bus, 
  Train, 
  ShieldCheck, 
  Bookmark,
  ChevronRight
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { fareLabel } from '../../utils/fare';

interface RouteCardProps {
  route: JourneyRoute;
  isSelected: boolean;
  onSelect: () => void;
  onOpenInspector: () => void;
  onViewDetails?: () => void;
  confirmationRequired?: boolean;
}

export const RouteCard: React.FC<RouteCardProps> = ({
  route,
  isSelected,
  onSelect,
  onOpenInspector,
  onViewDetails,
  confirmationRequired = false,
}) => {
  const isAffected = route.affectedByDisruption;
  const accessibilityStatus = route.accessibilityStatus
    ?? (route.isStepFree ? 'verified' : 'inaccessible');

  return (
    <div
      data-reveal
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`route-card p-5 rounded-xl border text-left transition-all cursor-pointer relative ${
        isAffected
          ? 'bg-rose-50/50 border-disruption ring-1 ring-disruption/50'
          : isSelected
          ? 'bg-white border-accent ring-1 ring-accent/20'
          : 'bg-white border-subtle-border hover:border-accent/40'
      }`}
    >
      {/* Top badges & label */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {confirmationRequired && <Badge variant="disruption">Confirmation needed</Badge>}
          {route.categoryTags.includes('fastest') && (
            <Badge variant="accessible">Fastest</Badge>
          )}
          {route.categoryTags.includes('cheapest') && (
            <Badge variant="accent">Lowest Cost</Badge>
          )}
          {route.categoryTags.includes('least_walking') && (
            <Badge variant="neutral">Least Walking</Badge>
          )}
          {isAffected && (
            <Badge variant="disruption" className="animate-pulse">
              Disrupted
            </Badge>
          )}
        </div>

        <span className="text-xs font-semibold text-slate-500">
          {route.departureTime} &ndash; {route.arrivalTime}
        </span>
      </div>

      <p className="mb-2 text-xs font-semibold text-ink">{route.label}</p>

      {/* Main duration and fare */}
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <span className="font-heading font-extrabold text-2xl text-ink">
            {Math.round(route.totalDurationMinutes)}
          </span>
          <span className="text-xs font-medium text-ink-muted">min</span>
        </div>

        <div className="flex items-center gap-1 font-heading font-bold text-base text-right text-ink">
          <span>{fareLabel(route.totalFareINR, route.fareStatus)}</span>
        </div>
      </div>

      {/* Key metrics grid */}
      <div className="grid grid-cols-2 gap-2 py-2.5 px-3 bg-slate-50/80 rounded-lg text-xs mb-3 border border-slate-100">
        <div className="flex items-center gap-1.5 text-ink-secondary">
          <Footprints className="w-3.5 h-3.5 text-accent" />
          <span>Walk: <strong>{Math.round(route.walkingDistanceMeters)} m</strong></span>
        </div>
        <div className="flex items-center gap-1.5 text-ink-secondary">
          <span className="font-bold text-slate-400">⇌</span>
          <span>Transfers: <strong>{route.transfersCount}</strong></span>
        </div>
      </div>

      {/* Modes & Step-free status */}
      <div className="flex items-center justify-between text-xs mb-3 text-slate-600">
        <div className="flex items-center gap-1.5">
          {route.transportModes.map((mode, i) => (
            <span key={i} className="p-1 rounded bg-slate-100 text-slate-700">
              {mode === 'bus' ? <Bus className="w-3 h-3" /> : 
               mode === 'train' || mode === 'metro' ? <Train className="w-3 h-3" /> : 
               <Footprints className="w-3 h-3" />}
            </span>
          ))}
        </div>

        {accessibilityStatus === 'verified' ? (
          <span className="flex items-center gap-1 font-semibold text-accessible text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {route.accessibilityStatus ? 'Tag-supported step-free' : 'Step-free verified'}
          </span>
        ) : accessibilityStatus === 'uncertain' ? (
          <span className="flex items-center gap-1 font-semibold text-warning text-[11px]">
            <HelpCircle className="w-3.5 h-3.5" />
            Step-free status unknown
          </span>
        ) : (
          <span className="flex items-center gap-1 font-semibold text-disruption text-[11px]">
            <AlertTriangle className="w-3.5 h-3.5" />
            Contains Stairs
          </span>
        )}
      </div>

      {/* Disruption alert message if affected */}
      {isAffected && (
        <div className="p-2.5 mb-3 rounded-lg bg-disruption-subtle border border-disruption-border text-xs text-disruption flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Journey Route Affected</div>
            <div className="text-[11px] leading-snug">{route.disruptionReason}</div>
          </div>
        </div>
      )}

      {/* Actions: Constraint Inspector Signature Button & View Details */}
      <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenInspector();
          }}
          className="text-xs font-semibold text-accent hover:text-accent-hover flex items-center gap-1 hover:underline"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          Why does this route work?
        </button>

        {onViewDetails && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onViewDetails();
            }}
            className="text-xs font-medium text-slate-500 hover:text-ink flex items-center gap-0.5"
          >
            Itinerary <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

