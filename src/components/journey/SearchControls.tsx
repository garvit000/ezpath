import React from 'react';
import { useJourneyStore } from '../../stores/journeyStore';
import { getCampusLocation, LOCATION_GROUPS } from '../../data/networkLocations';
import { isDemoMode } from '../../config/runtime';
import { ProfileBuilder } from '../accessibility/ProfileBuilder';
import { Button } from '../ui/Button';
import { 
  ArrowUpDown, 
  MapPin, 
  Navigation2, 
  Search, 
  SlidersHorizontal,
  Bus,
  Train,
  Footprints
} from 'lucide-react';

interface SearchControlsProps {
  onSearch?: () => void;
}

export const SearchControls: React.FC<SearchControlsProps> = ({ onSearch }) => {
  const {
    originId,
    destinationId,
    setOriginId,
    setDestinationId,
    swapLocations,
    searchJourneys,
    isLoading,
    profile,
    setAllowedModes
  } = useJourneyStore();
  const campusTrip = !isDemoMode && Boolean(getCampusLocation(originId) && getCampusLocation(destinationId));

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    await searchJourneys();
    if (onSearch) onSearch();
  };

  const toggleMode = (mode: 'bus' | 'train' | 'metro') => {
    const current = profile.allowedModes;
    if (current.includes(mode)) {
      if (current.filter(m => m !== 'walking').length > 1) {
        setAllowedModes(current.filter(m => m !== mode));
      }
    } else {
      setAllowedModes([...current, mode]);
    }
  };

  const locationOptions = LOCATION_GROUPS.map(group => (
    <optgroup key={group.label} label={group.label}>
      {group.locations.map(location => (
        <option key={location.id} value={location.id}>{location.name}</option>
      ))}
    </optgroup>
  ));

  const transitButton = (mode: 'bus' | 'train' | 'metro', label: string, icon: React.ReactNode, isActive: boolean) => (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={() => toggleMode(mode)}
      className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg border text-xs font-medium transition-colors ${
        isActive
          ? 'bg-blue-50 text-accent border-blue-200 font-semibold'
          : 'bg-white text-slate-400 border-slate-200 hover:bg-slate-50'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <form onSubmit={handleSearch} className="space-y-4 p-4 text-ink">
      {/* Origin & Destination inputs */}
      <div className="space-y-2 relative">
        {/* Origin */}
        <div className="relative">
          <label htmlFor="origin-select" className="sr-only">Origin Location</label>
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-accent">
            <MapPin className="w-4 h-4" />
          </div>
          <select
            id="origin-select"
            value={originId}
            onChange={(e) => setOriginId(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 bg-white border border-subtle-border rounded-lg text-xs font-medium text-ink focus:border-accent focus:ring-1 focus:ring-accent"
          >
            {locationOptions}
          </select>
        </div>

        {/* Swap button */}
        <div className="flex justify-end pr-2 -my-1 z-10 relative">
          <button
            type="button"
            onClick={swapLocations}
            aria-label="Swap starting location and destination"
            className="p-2 rounded-full bg-slate-100 hover:bg-slate-200 text-ink-muted hover:text-ink transition-colors border border-subtle-border"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Destination */}
        <div className="relative">
          <label htmlFor="dest-select" className="sr-only">Destination Location</label>
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-accessible">
            <Navigation2 className="w-4 h-4" />
          </div>
          <select
            id="dest-select"
            value={destinationId}
            onChange={(e) => setDestinationId(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 bg-white border border-subtle-border rounded-lg text-xs font-medium text-ink focus:border-accessible focus:ring-1 focus:ring-accessible"
          >
            {locationOptions}
          </select>
        </div>
      </div>

      {/* Allowed transit modes */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
          Permitted Modes
        </label>
        <div className="grid grid-cols-2 gap-2">
          {/* Walking always allowed */}
          <div className="flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg bg-emerald-50 text-accessible border border-emerald-200 text-xs font-medium cursor-not-allowed">
            <Footprints className="w-3.5 h-3.5" />
            <span>Walking</span>
          </div>

          {transitButton('bus', 'Bus', <Bus className="w-3.5 h-3.5" />, profile.allowedModes.includes('bus'))}
          {isDemoMode
            ? transitButton('train', 'Metro', <Train className="w-3.5 h-3.5" />, profile.allowedModes.includes('train') || profile.allowedModes.includes('metro'))
            : <>
                {transitButton('metro', 'Metro', <Train className="w-3.5 h-3.5" />, profile.allowedModes.includes('metro'))}
                {transitButton('train', 'Suburban', <Train className="w-3.5 h-3.5" />, profile.allowedModes.includes('train'))}
              </>}
        </div>
        {!isDemoMode && (
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            {campusTrip
              ? 'Both places are on the SRM campus, so this is a walking route and these modes do not apply.'
              : 'Results update when you change a mode. Times come from published timetables, not live vehicle positions.'}
          </p>
        )}
      </div>

      {/* Profile Builder Section */}
      <div className="pt-2 border-t border-subtle-border">
        <ProfileBuilder />
      </div>

      {/* Primary Submit Action stays reachable while the form scrolls */}
      <div className="lg:sticky lg:bottom-0 lg:z-10 lg:-mx-4 lg:-mb-4 lg:border-t lg:border-subtle-border lg:bg-white/95 lg:p-4 lg:backdrop-blur-md">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isLoading}
          className="w-full font-semibold shadow-md"
        >
          <Search className="w-4 h-4 mr-2" />
          Find Accessible Routes
        </Button>
      </div>
    </form>
  );
};

