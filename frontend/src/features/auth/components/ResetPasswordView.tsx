import { useEffect, useState } from 'preact/hooks';
import { confirmPasswordReset } from '@shared/api/client';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AuthFrame, LoadingState, StatusNotice } from './AuthFrame';
import { PasswordField } from './PasswordField';
import { authErrorMessage, consumeUrlValue, passwordValidation } from '../lib/ui';

type ResetState = 'checking' | 'missing' | 'ready' | 'submitting' | 'success';

export default function ResetPasswordView() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [state, setState] = useState<ResetState>('checking');
  const [error, setError] = useState('');

  useEffect(() => {
    const queryToken = consumeUrlValue('token');
    setToken(queryToken);
    setState(queryToken ? 'ready' : 'missing');
  }, []);

  const submit = async (event: Event) => {
    event.preventDefault();
    const validationError = passwordValidation(password, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setState('submitting');
    setError('');
    try {
      await confirmPasswordReset(token, password);
      setState('success');
    } catch (requestError) {
      setError(authErrorMessage(requestError, 'No fue posible restablecer la contraseña.', {
        400: 'El enlace de recuperación no es válido, ya fue utilizado o expiró.',
      }));
      setState('ready');
    }
  };

  const submitting = state === 'submitting';

  return (
    <AuthFrame
      title="Nueva contraseña"
      footer={<a class="auth-link" href="/auth/login/">Volver al inicio de sesión</a>}
    >
      {state === 'checking' && <LoadingState label="Leyendo enlace…" />}
      {state === 'missing' && (
        <div class="auth-success">
          <StatusNotice kind="error">El enlace no contiene un token de recuperación.</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/forgot-password/">Solicitar un enlace nuevo</a>
        </div>
      )}
      {state === 'success' && (
        <div class="auth-success">
          <StatusNotice kind="success">La contraseña fue actualizada y las sesiones anteriores quedaron invalidadas.</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/login/">
            <LucideIcon name="log-in" />
            Iniciar sesión
          </a>
        </div>
      )}
      {(state === 'ready' || state === 'submitting') && (
        <form class="auth-form" onSubmit={submit}>
          <PasswordField
            id="reset-password"
            name="password"
            label="Contraseña nueva"
            value={password}
            onInput={setPassword}
            autoComplete="new-password"
            describedBy="reset-password-help"
            placeholder="Mínimo 12 caracteres"
            minLength={12}
            disabled={submitting}
          />
          <p id="reset-password-help" class="auth-field-help">Entre 12 y 128 caracteres; sin espacios al inicio o al final.</p>
          <PasswordField
            id="reset-confirmation"
            name="password-confirmation"
            label="Confirmar contraseña"
            value={confirmation}
            onInput={setConfirmation}
            autoComplete="new-password"
            placeholder="Repite la contraseña"
            minLength={12}
            disabled={submitting}
          />
          {error && <StatusNotice kind="error">{error}</StatusNotice>}
          <button class="auth-button auth-button-block" type="submit" disabled={submitting}>
            <LucideIcon name={submitting ? 'loader-circle' : 'key-round'} className={submitting ? 'auth-spin' : ''} />
            {submitting ? 'Actualizando…' : 'Actualizar contraseña'}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
