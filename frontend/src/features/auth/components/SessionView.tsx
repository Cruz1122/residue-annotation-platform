import { useEffect, useState } from 'preact/hooks';
import { getCurrentUser, logout } from '@shared/api/client';
import { readAuthSession, type AuthUser } from '@shared/auth/session';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { AuthFrame, LoadingState, StatusNotice } from './AuthFrame';
import { authErrorMessage } from '../lib/ui';

type SessionState = 'loading' | 'ready' | 'error' | 'logging-out';

function roleLabel(role: AuthUser['role']): string {
  return role === 'admin' ? 'Administrador' : 'Usuario';
}

export default function SessionView() {
  const [user, setUser] = useState<AuthUser | null>(() => readAuthSession()?.user ?? null);
  const [state, setState] = useState<SessionState>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    void getCurrentUser()
      .then((current) => {
        if (!active) return;
        setUser(current);
        setState('ready');
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setError(authErrorMessage(requestError, 'No fue posible cargar la cuenta.'));
        setState('error');
      });
    return () => { active = false; };
  }, [attempt]);

  const closeSession = async () => {
    setState('logging-out');
    try {
      await logout();
    } finally {
      window.location.assign('/auth/login/');
    }
  };

  return (
    <AuthFrame
      title="Tu cuenta"
      footer={<a class="auth-link" href="/proteins/">Volver a mis proteínas</a>}
    >
      {state === 'loading' && <LoadingState label="Validando cuenta…" />}
      {state === 'error' && (
        <div class="auth-success">
          <StatusNotice kind="error">{error}</StatusNotice>
          <button class="auth-button auth-button-block" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {(state === 'ready' || state === 'logging-out') && user && (
        <>
          <dl class="auth-meta-list">
            <div class="auth-meta-row"><dt>Correo</dt><dd>{user.email}</dd></div>
            <div class="auth-meta-row"><dt>Rol</dt><dd>{roleLabel(user.role)}</dd></div>
            <div class="auth-meta-row">
              <dt>Verificación</dt>
              <dd><span class={`auth-status ${user.email_verified ? 'auth-status-ok' : 'auth-status-bad'}`}>{user.email_verified ? 'Correo verificado' : 'Pendiente'}</span></dd>
            </div>
            <div class="auth-meta-row"><dt>Proyecto</dt><dd class="auth-meta-code">{user.project_id}</dd></div>
            <div class="auth-meta-row"><dt>ID de cuenta</dt><dd class="auth-meta-code">{user.id}</dd></div>
          </dl>
          <div class="auth-actions">
            <a class="auth-button auth-button-secondary" href="/auth/change-password/">
              <PackIcon name="key-round" kind="ui" />
              Cambiar contraseña
            </a>
            {user.role === 'admin' && (
              <a class="auth-button auth-button-secondary" href="/auth/users/">
              <PackIcon name="users-round" kind="ui" />
                Administrar usuarios
              </a>
            )}
            <button class="auth-button auth-button-danger" type="button" disabled={state === 'logging-out'} onClick={closeSession}>
              <PackIcon name={state === 'logging-out' ? 'loader-circle' : 'log-out'} kind="ui" className={state === 'logging-out' ? 'auth-spin' : ''} />
              {state === 'logging-out' ? 'Cerrando…' : 'Cerrar sesión'}
            </button>
          </div>
        </>
      )}
    </AuthFrame>
  );
}
