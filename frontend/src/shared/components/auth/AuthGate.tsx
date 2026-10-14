import { useEffect, useState } from 'preact/hooks';
import { ApiError, getCurrentUser } from '@shared/api/client';
import { readAuthSession, safeInternalPath } from '@shared/auth/session';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
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
        setMessage(error instanceof ApiError
          ? error.message
          : 'No se pudo validar tu sesión.');
        setState('error');
      });
    return () => { active = false; };
  }, [attempt]);

  if (state === 'ready') return null;

  return (
    <div class="auth-gate" role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
      <div class={`auth-gate-content auth-gate-${state}`}>
        <LucideIcon name={state === 'error' ? 'circle-x' : 'loader-circle'} />
        <strong>{state === 'error' ? 'No pudimos validar la sesión' : 'Validando sesión'}</strong>
        <span>{state === 'error' ? message : 'Espera un momento.'}</span>
        {state === 'error' && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}
