import { useEffect, useState } from 'preact/hooks';
import { ApiError, getCurrentUser } from '@shared/api/client';
import { readAuthSession, safeInternalPath } from '@shared/auth/session';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { userErrorMessage } from '@shared/lib/error-presentation';
import './auth-gate.css';

type GateState = 'checking' | 'ready' | 'error';

function loginRedirect(): void {
  const next = safeInternalPath(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    '/proteins/',
  );
  window.location.replace(`/auth/login/?next=${encodeURIComponent(next)}`);
}

export default function AuthGate() {
  const [state, setState] = useState<GateState>('checking');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!readAuthSession()) {
      loginRedirect();
      return undefined;
    }

    let active = true;
    setState('checking');
    setMessage('');
    getCurrentUser()
      .then(() => {
        if (active) setState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          loginRedirect();
          return;
        }
        setMessage(userErrorMessage(error, 'No se pudo validar tu sesión.'));
        setState('error');
      });
    return () => { active = false; };
  }, [attempt]);

  if (state === 'ready') return null;

  return (
    <div class="auth-gate">
      <StatePanel
        kind={state === 'error' ? 'error' : 'loading'}
        compact
        title={state === 'error' ? 'No pudimos validar la sesión' : 'Validando sesión'}
        description={state === 'error' ? message : 'Espera un momento.'}
        className="auth-gate-content"
      >
        {state === 'error' && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Reintentar
          </button>
        )}
      </StatePanel>
    </div>
  );
}
