import { useEffect, useState } from 'preact/hooks';
import { getHealth } from '@shared/api/client';

export default function HealthStatus() {
  const [state, setState] = useState('checking');

  useEffect(() => {
    let active = true;
    getHealth()
      .then((payload) => {
        if (active) setState(payload?.status === 'ok' ? 'connected' : 'unavailable');
      })
      .catch(() => {
        if (active) setState('unavailable');
      });
    return () => { active = false; };
  }, []);

  const label = state === 'checking' ? 'Checking' : state === 'connected' ? 'Connected' : 'Unavailable';
  return (
    <span class={`api-health api-health-${state}`} role="status" aria-live="polite">
      <span class="api-health-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
