import { useState } from 'preact/hooks';
import { requestPasswordReset } from '@shared/api/client';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { AuthFrame, StatusNotice } from './AuthFrame';
import { authErrorMessage } from '../lib/ui';

export default function ForgotPasswordView() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: Event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await requestPasswordReset(email);
      setResetToken(response.reset_token ?? '');
      setCompleted(true);
    } catch (requestError) {
      setError(authErrorMessage(requestError, 'No fue posible solicitar el cambio de contraseña.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Recuperar acceso"
      footer={<a class="auth-link" href="/auth/login/">Volver al inicio de sesión</a>}
    >
      {completed ? (
        <div class="auth-success">
          <StatusNotice kind="success">
            Si existe una cuenta para ese correo, enviaremos las instrucciones de recuperación.
          </StatusNotice>
          {resetToken && (
            <>
              <a class="auth-button auth-button-block" href={`/auth/reset-password/#token=${encodeURIComponent(resetToken)}`}>
                <PackIcon name="key-round" kind="ui" />
                Abrir enlace de desarrollo
              </a>
              <p class="auth-field-help">Este acceso solo aparece cuando el backend expone tokens en desarrollo.</p>
            </>
          )}
          <button class="auth-button auth-button-secondary auth-button-block" type="button" onClick={() => setCompleted(false)}>
            Usar otro correo
          </button>
        </div>
      ) : (
        <form class="auth-form" onSubmit={submit}>
          <label class="auth-field" for="reset-request-email">
            <span>Correo electrónico</span>
            <input
              id="reset-request-email"
              name="email"
              type="email"
              value={email}
              onInput={(event) => setEmail(event.currentTarget.value)}
              autoComplete="email"
              inputMode="email"
              placeholder="tu@correo.com"
              maxLength={320}
              disabled={submitting}
              required
              autofocus
            />
          </label>
          {error && <StatusNotice kind="error">{error}</StatusNotice>}
          <button class="auth-button auth-button-block" type="submit" disabled={submitting}>
            <PackIcon name={submitting ? 'loader-circle' : 'mail'} kind="ui" className={submitting ? 'auth-spin' : ''} />
            {submitting ? 'Solicitando…' : 'Enviar enlace de recuperación'}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
