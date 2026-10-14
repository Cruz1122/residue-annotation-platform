import { useEffect, useRef, useState } from 'preact/hooks';
import { logout } from '@shared/api/client';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AuthFrame, LoadingState, StatusNotice } from './AuthFrame';

type LogoutState = 'closing' | 'closed';

export default function LogoutView() {
  const [state, setState] = useState<LogoutState>('closing');
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void logout().catch(() => undefined).finally(() => setState('closed'));
  }, []);

  return (
    <AuthFrame
      title="Cerrar sesión"
      footer={<a class="auth-link" href="/auth/login/">Volver al inicio de sesión</a>}
    >
      {state === 'closing' ? <LoadingState label="Cerrando sesión…" /> : (
        <div class="auth-success">
          <StatusNotice kind="success">La sesión se cerró en este navegador.</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/login/">
            <LucideIcon name="log-in" />
            Iniciar sesión
          </a>
        </div>
      )}
    </AuthFrame>
  );
}
