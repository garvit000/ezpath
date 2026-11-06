import React, { useState } from 'react';
import { Layers, ChevronUp, ChevronDown } from 'lucide-react';

interface MapLegendProps {
  className?: string;
}

const LINES = [
  { label: 'Metro', style: 'bg-[#0B5CAD]' },
  { label: 'Suburban train', style: 'bg-[#7A3E9D]' },
  { label: 'Bus', style: 'bg-[#C2570C]' },
];

export const MapLegend: React.FC<MapLegendProps> = ({ className = 'bottom-4 left-1/2 -translate-x-1/2' }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`absolute z-20 pointer-events-auto transition-all ${className}`}>
      <div className="bg-white/95 backdrop-blur-md rounded-xl border border-slate-200/90 shadow-floating text-xs overflow-hidden">
        {isExpanded && (
          <div className="p-3 border-b border-slate-100 space-y-1.5 min-w-[190px]">
            {LINES.map((line) => (
              <div key={line.label} className="flex items-center gap-2">
                <div className={`w-5 h-1.5 rounded-full ${line.style}`} />
                <span className="text-ink">{line.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <div className="w-5 border-t-[3px] border-dashed border-accessible" />
              <span className="text-ink">Walking</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-slate-700 border border-white" />
              <span className="text-ink">SRM campus location</span>
            </div>
          </div>
        )}
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full px-3 py-2 flex items-center justify-between gap-3 text-[11px] font-bold text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <span className="flex items-center gap-1.5 uppercase tracking-wider text-slate-500">
            <Layers className="w-3.5 h-3.5 text-accent" />
            Map legend
          </span>
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-400" />}
        </button>
      </div>
    </div>
  );
};
