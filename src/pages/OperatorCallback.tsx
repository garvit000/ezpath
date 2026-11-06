import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { authService } from '../services/auth/cognito';

export const OperatorCallback: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    authService
      .completeSignIn()
      .then(() => {
        if (active) navigate('/operator', { replace: true });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Operator sign-in failed.');
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <main className="product-page flex min-h-[60vh] items-center justify-center">
      <section className="workspace-panel max-w-lg space-y-4 text-center" aria-live="polite">
        <ShieldCheck className="mx-auto h-10 w-10 text-accent" />
        <h1 className="product-title text-2xl">Completing operator sign-in</h1>
        {error ? (
          <>
            <p className="text-disruption">{error}</p>
            <button className="workspace-link mx-auto" onClick={() => navigate('/operator')}>
              Return to operator workspace
            </button>
          </>
        ) : (
          <p className="product-description">Verifying the Cognito response and short-lived session.</p>
        )}
      </section>
    </main>
  );
};
