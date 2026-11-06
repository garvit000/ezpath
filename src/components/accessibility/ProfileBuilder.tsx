import React from 'react';
import { useJourneyStore, DEFAULT_PROFILES } from '../../stores/journeyStore';
import { 
  Accessibility, 
  ShieldCheck, 
  Footprints, 
  Sparkles, 
  IndianRupee, 
  Info,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { MobilityProfileId } from '../../types';
import { isDemoMode } from '../../config/runtime';

export const ProfileBuilder: React.FC = () => {
  const { profile, setProfile, updateProfileConstraint } = useJourneyStore();

  const profileOptions: { id: MobilityProfileId; label: string; icon: any }[] = [
    { id: 'wheelchair', label: 'Wheelchair', icon: Accessibility },
    { id: 'step_free', label: 'Step-Free', icon: ShieldCheck },
    { id: 'limited_walking', label: 'Limited Walk', icon: Footprints },
    { id: 'standard', label: 'Standard', icon: Sparkles },
    { id: 'custom', label: 'Custom', icon: Accessibility },
  ];

  return (
    <div className="space-y-4 text-ink">
      {/* Profile quick selector buttons */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
          Mobility Profile
        </label>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200">
          {profileOptions.map(opt => {
            const Icon = opt.icon;
            const isSelected = profile.id === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setProfile(opt.id)}
                className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg text-xs font-medium transition-all ${
                  isSelected
                    ? 'bg-white text-accent font-semibold shadow-subtle border border-slate-200'
                    : 'text-ink-secondary hover:text-ink hover:bg-white/50'
                }`}
              >
                <Icon className={`w-4 h-4 mb-1 ${isSelected ? 'text-accent' : 'text-slate-400'}`} />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Profile active summary sentence */}
      <div className="p-3 rounded-xl bg-accent-subtle/50 border border-accent/15 text-xs text-ink space-y-1">
        <div className="flex items-center gap-1.5 font-semibold text-accent">
          <Info className="w-4 h-4 shrink-0" />
          <span>Active Requirements Summary</span>
        </div>
        <p className="text-slate-700 leading-relaxed">
          Your journey must {profile.requireStepFree ? 'be strictly step-free' : 'allow routes without a step-free requirement'},
          {' '}stay within <strong className="font-semibold text-ink">{profile.maxWalkingDistanceMeters} m</strong> of walking
          {isDemoMode && <>, and cost no more than <strong className="font-semibold text-ink">₹{profile.maxBudgetINR}</strong></>}.
        </p>
      </div>

      {/* Editable Constraints */}
      <div className="space-y-3 pt-1">
        <div className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
          Accessibility Constraints
        </div>

        {/* Avoid Stairs */}
        <label className="flex items-center justify-between p-2.5 rounded-lg border border-subtle-border hover:bg-slate-50 cursor-pointer transition-colors">
          <span className="text-xs font-medium text-ink">Avoid stairs & steep steps</span>
          <input
            type="checkbox"
            checked={profile.avoidStairs}
            onChange={(e) => updateProfileConstraint('avoidStairs', e.target.checked)}
            className="w-4 h-4 text-accent rounded border-slate-300 focus:ring-accent"
          />
        </label>

        {/* Require Step-Free Access */}
        <label className="flex items-center justify-between p-2.5 rounded-lg border border-subtle-border hover:bg-slate-50 cursor-pointer transition-colors">
          <span className="text-xs font-medium text-ink">Require verified step-free access</span>
          <input
            type="checkbox"
            checked={profile.requireStepFree}
            onChange={(e) => updateProfileConstraint('requireStepFree', e.target.checked)}
            className="w-4 h-4 text-accent rounded border-slate-300 focus:ring-accent"
          />
        </label>

        {/* Require Wheelchair-Accessible Boarding */}
        {isDemoMode && <label className="flex items-center justify-between p-2.5 rounded-lg border border-subtle-border hover:bg-slate-50 cursor-pointer transition-colors">
          <span className="text-xs font-medium text-ink">Wheelchair-accessible vehicle boarding</span>
          <input
            type="checkbox"
            checked={profile.requireWheelchairBoarding}
            onChange={(e) => updateProfileConstraint('requireWheelchairBoarding', e.target.checked)}
            className="w-4 h-4 text-accent rounded border-slate-300 focus:ring-accent"
          />
        </label>}

        {/* Max Walking Distance */}
        <div className="p-2.5 rounded-lg border border-subtle-border space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">Maximum walking distance</span>
            <span className="font-bold text-accent">{profile.maxWalkingDistanceMeters} m</span>
          </div>
          <input
            type="range"
            aria-label="Maximum walking distance in metres"
            min="100"
            max="3000"
            step="50"
            value={profile.maxWalkingDistanceMeters}
            onChange={(e) => updateProfileConstraint('maxWalkingDistanceMeters', Number(e.target.value))}
            className="w-full accent-accent cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-400">
            <span>100 m</span>
            <span>3,000 m</span>
          </div>
        </div>

        {/* Max Fare Budget */}
        {isDemoMode && <div className="p-2.5 rounded-lg border border-subtle-border space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">Maximum budget limit</span>
            <span className="font-bold text-accent flex items-center">
              <IndianRupee className="w-3.5 h-3.5" />
              {profile.maxBudgetINR}
            </span>
          </div>
          <input
            type="range"
            aria-label="Maximum budget in rupees"
            min="20"
            max="150"
            step="5"
            value={profile.maxBudgetINR}
            onChange={(e) => updateProfileConstraint('maxBudgetINR', Number(e.target.value))}
            className="w-full accent-accent cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-400">
            <span>₹20</span>
            <span>₹50</span>
            <span>₹150</span>
          </div>
        </div>}

        {/* Strict Verification Toggle */}
        <div className="p-2.5 rounded-lg border border-subtle-border bg-slate-50/70 space-y-1">
          <label className="flex items-center justify-between cursor-pointer">
            <div className="pr-2">
              <div className="text-xs font-semibold text-ink flex items-center gap-1">
                Strict Accessibility Verification
              </div>
              <p className="text-[11px] text-ink-muted">
                Exclude segments with unknown accessibility data.
              </p>
            </div>
            <input
              type="checkbox"
              checked={profile.strictVerification}
              onChange={(e) => updateProfileConstraint('strictVerification', e.target.checked)}
              className="w-4 h-4 text-accent rounded border-slate-300 focus:ring-accent"
            />
          </label>
        </div>
      </div>
    </div>
  );
};

