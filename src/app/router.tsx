import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { LandingPage } from '../pages/LandingPage';
import { JourneyPlanner } from '../pages/JourneyPlanner';
import { JourneyDetails } from '../pages/JourneyDetails';
import { SavedJourneys } from '../pages/SavedJourneys';
import { OperatorDashboard } from '../pages/OperatorDashboard';
import { NetworkStatus } from '../pages/NetworkStatus';
import { Analytics } from '../pages/Analytics';
import { OperatorCallback } from '../pages/OperatorCallback';
import { CommunityReportPage } from '../pages/CommunityReportPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <AppShell>
        <LandingPage />
      </AppShell>
    ),
  },
  {
    path: '/plan',
    element: (
      <AppShell>
        <JourneyPlanner />
      </AppShell>
    ),
  },
  {
    path: '/journey/:id',
    element: (
      <AppShell>
        <JourneyDetails />
      </AppShell>
    ),
  },
  {
    path: '/saved',
    element: (
      <AppShell>
        <SavedJourneys />
      </AppShell>
    ),
  },
  {
    path: '/report',
    element: (
      <AppShell>
        <CommunityReportPage />
      </AppShell>
    ),
  },
  {
    path: '/operator/callback',
    element: <OperatorCallback />,
  },
  {
    path: '/operator',
    element: (
      <AppShell>
        <OperatorDashboard />
      </AppShell>
    ),
  },
  {
    path: '/operator/network',
    element: (
      <AppShell>
        <NetworkStatus />
      </AppShell>
    ),
  },
  {
    path: '/operator/analytics',
    element: (
      <AppShell>
        <Analytics />
      </AppShell>
    ),
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);

