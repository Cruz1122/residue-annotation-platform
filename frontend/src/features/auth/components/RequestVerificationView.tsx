import { useEffect, useState } from 'preact/hooks';
import { requestEmailVerification } from '@shared/api/client';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { AuthFrame, StatusNotice } from './AuthFrame';
import { authErrorMessage, queryValue } from '../lib/ui';

export default function RequestVerificationView() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [verificationToken, setVerificationToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setEmail(queryValue('email')), []);

  const submit = async (event: Event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await requestEmailVerification(email);
      setVerificationToken(response.verification_token ?? '');
      setCompleted(true);
    } catch (requestError) {
      setError(authErrorMessage(requestError, 'No fue posible solicitar la verificación.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Verificar correo"
      footer={<a class="auth-link" href="/auth/login/">Volver al inicio de sesión</a>}
    >
      {completed ? (
        <div class="auth-success">
          <StatusNotice kind="success">
            Si la cuenta existe y puede verificarse, recibirás las instrucciones correspondientes.
          </StatusNotice>
          {verificationToken && (
            <>
              <a class="auth-button auth-button-block" href={`/auth/verify-email/#token=${encodeURIComponent(verificationToken)}`}>
                <PackIcon name="mail-check" kind="ui" />
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
          <label class="auth-field" for="verification-email">
            <span>Correo electrónico</span>
            <input
              id="verification-email"
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
            <PackIcon name={submitting ? 'loader-circle' : 'mail-check'} kind="ui" className={submitting ? 'auth-spin' : ''} />
            {submitting ? 'Solicitando…' : 'Enviar verificación'}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
