import { useEffect, useState } from 'preact/hooks';
import { getCurrentUser, listAuthUsers, updateUserRole } from '@shared/api/client';
import { clearAuthSession, type AuthUser, type UserRole } from '@shared/auth/session';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AuthFrame, LoadingState, StatusNotice } from './AuthFrame';
import { authErrorMessage } from '../lib/ui';

type ViewState = 'loading' | 'ready' | 'forbidden' | 'error';
interface PendingRoleChange { user: AuthUser; role: UserRole; }

function roleLabel(role: UserRole): string {
  return role === 'admin' ? 'Administrador' : 'Usuario';
}

export default function UsersAdminView() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [pending, setPending] = useState<PendingRoleChange | null>(null);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    Promise.all([getCurrentUser(), listAuthUsers()])
      .then(([account, items]) => {
        if (!active) return;
        if (account.role !== 'admin') {
          setState('forbidden');
          return;
        }
        setCurrentUser(account);
        setUsers(items);
        setState('ready');
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof Error && 'status' in requestError && requestError.status === 403) {
          setState('forbidden');
          return;
        }
        setError(authErrorMessage(requestError, 'No fue posible cargar los usuarios.'));
        setState('error');
      });
    return () => { active = false; };
  }, [attempt]);

  const confirmChange = async () => {
    if (!pending) return;
    setSavingId(pending.user.id);
    setError('');
    setNotice('');
    try {
      const updated = await updateUserRole(pending.user.id, pending.role);
      setUsers((items) => items.map((item) => item.id === updated.id ? updated : item));
      setNotice(`${updated.email} ahora tiene rol ${roleLabel(updated.role).toLowerCase()}.`);
      setPending(null);
      if (currentUser?.id === updated.id) {
        clearAuthSession();
        window.location.assign('/auth/login/');
      }
    } catch (requestError) {
      setError(authErrorMessage(requestError, 'No fue posible cambiar el rol.', {
        409: 'No puedes quitar el rol al último administrador.',
      }));
    } finally {
      setSavingId('');
    }
  };

  return (
    <AuthFrame
      title="Usuarios"
      wide
      footer={<a class="auth-link" href="/auth/session/">Volver a tu cuenta</a>}
    >
      {state === 'loading' && <LoadingState label="Cargando usuarios…" />}
      {state === 'forbidden' && (
        <div class="auth-success">
          <StatusNotice kind="error">Esta sección requiere el rol administrador.</StatusNotice>
          <a class="auth-button auth-button-block" href="/proteins/">Volver a mis proteínas</a>
        </div>
      )}
      {state === 'error' && (
        <div class="auth-success">
          <StatusNotice kind="error">{error}</StatusNotice>
          <button class="auth-button auth-button-block" type="button" onClick={() => setAttempt((value) => value + 1)}>Reintentar</button>
        </div>
      )}
      {state === 'ready' && (
        <>
          <div class="auth-admin-toolbar">
            <p>{users.length} cuenta{users.length === 1 ? '' : 's'} registrada{users.length === 1 ? '' : 's'}</p>
            <a class="auth-button auth-button-secondary auth-button-compact" href="/proteins/">
              <LucideIcon name="arrow-left" />
              Volver
            </a>
          </div>
          {notice && <StatusNotice kind="success">{notice}</StatusNotice>}
          {error && <StatusNotice kind="error">{error}</StatusNotice>}
          <div class="auth-table-wrap">
            <table class="auth-table">
              <thead><tr><th>Cuenta</th><th>Estado</th><th>Rol</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <>
                    <tr key={user.id}>
                      <td>
                        <div class="auth-user-email">
                          <strong>{user.email}{currentUser?.id === user.id ? ' · tú' : ''}</strong>
                          <span>{user.id}</span>
                        </div>
                      </td>
                      <td><span class={`auth-status ${user.is_active && user.email_verified ? 'auth-status-ok' : 'auth-status-bad'}`}>{user.is_active ? (user.email_verified ? 'Activa' : 'Sin verificar') : 'Desactivada'}</span></td>
                      <td>
                        <select
                          class="auth-select auth-role-select"
                          aria-label={`Rol de ${user.email}`}
                          value={user.role}
                          disabled={Boolean(savingId)}
                          onChange={(event) => {
                            const role = event.currentTarget.value as UserRole;
                            if (role !== user.role) setPending({ user, role });
                          }}
                        >
                          <option value="user">Usuario</option>
                          <option value="admin">Administrador</option>
                        </select>
                      </td>
                    </tr>
                    {pending?.user.id === user.id && (
                      <tr class="auth-confirm-row" key={`${user.id}-confirmation`}>
                        <td colSpan={3}>
                          <div class="auth-confirm">
                            <span>Cambiar a <strong>{roleLabel(pending.role)}</strong> e invalidar sus sesiones.</span>
                            <button class="auth-button auth-button-secondary auth-button-compact" type="button" disabled={Boolean(savingId)} onClick={() => setPending(null)}>Cancelar</button>
                            <button class="auth-button auth-button-compact" type="button" disabled={Boolean(savingId)} onClick={confirmChange}>
                              <LucideIcon name={savingId ? 'loader-circle' : 'circle-check'} className={savingId ? 'auth-spin' : ''} />
                              {savingId ? 'Guardando…' : 'Confirmar'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AuthFrame>
  );
}
