import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useScrollReveal } from '../../hooks/useScrollReveal';
import { ScrollProgress } from './ScrollProgress';
import { Navbar } from './Navbar';
import { Footer } from './Footer';
import { SkipLink } from '../ui/SkipLink';
import { PwaInstallBanner } from '../ui/PwaInstallBanner';
import { liveEventsService } from '../../services/realtime/liveEvents';
import { useJourneyStore } from '../../stores/journeyStore';
import { useOperatorStore } from '../../stores/operatorStore';
import { isDemoMode } from '../../config/runtime';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useLayoutEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [pathname]);
  useScrollReveal(main, pathname);
  const { handleDisruptionNotification } = useJourneyStore();
  const { loadNetworkData } = useOperatorStore();

  useEffect(() => {
    // Initial load of network data
    loadNetworkData();

    // Subscribe to live disruption events across tabs and sockets
    const unsubscribe = liveEventsService.subscribe((events) => {
      handleDisruptionNotification(events);
      if (!isDemoMode) useOperatorStore.setState({ disruptions: events, loadError: null });
    });

    return () => {
      unsubscribe();
    };
  }, [handleDisruptionNotification, loadNetworkData]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-ink">
      <SkipLink />
      <ScrollProgress />
      <Navbar />
      <main ref={main} id="main-content" className="flex-1 flex flex-col">
        {children}
      </main>
      <Footer />
      {/* Floating PWA Install Banner */}
      <PwaInstallBanner />
    </div>
  );
};
