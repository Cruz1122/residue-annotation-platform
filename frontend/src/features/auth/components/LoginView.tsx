import { useState } from 'preact/hooks';
import { login } from '@shared/api/client';
import { safeInternalPath } from '@shared/auth/session';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AuthFrame, StatusNotice } from './AuthFrame';
import { PasswordField } from './PasswordField';
import { authErrorMessage } from '../lib/ui';

export default function LoginView() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [verificationRequired, setVerificationRequired] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setVerificationRequired(false);

    try {
      await login(email, password);
      const next = safeInternalPath(
        new URLSearchParams(window.location.search).get('next'),
        '/proteins/',
      );
      window.location.assign(next);
    } catch (requestError) {
      const needsVerification = requestError instanceof Error
        && 'status' in requestError
        && requestError.status === 403;
      setVerificationRequired(needsVerification);
      setError(authErrorMessage(requestError, 'No fue posible iniciar sesión.', {
        401: 'El correo o la contraseña no son correctos.',
        403: 'La cuenta debe estar verificada y activa antes de iniciar sesión.',
      }));
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Iniciar sesión"
      footer={<><span>¿No tienes una cuenta?</span><a class="auth-link" href="/auth/register/">Crear cuenta</a></>}
    >
      <form class="auth-form" onSubmit={submit}>
        <label class="auth-field" for="login-email">
          <span>Correo electrónico</span>
          <input
            id="login-email"
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

        <PasswordField
          id="login-password"
          name="password"
          label="Contraseña"
          value={password}
          onInput={setPassword}
          autoComplete="current-password"
          placeholder="••••••••••••"
          disabled={submitting}
        />

        <div class="auth-row">
          <a class="auth-link" href="/auth/forgot-password/">Olvidé mi contraseña</a>
          <a class="auth-link" href="/auth/request-verification/">Reenviar verificación</a>
        </div>

        {error && (
          <StatusNotice kind="error">
            <p>{error}</p>
            {verificationRequired && email && (
              <p><a class="auth-link" href={`/auth/request-verification/?email=${encodeURIComponent(email)}`}>Solicitar un correo nuevo</a></p>
            )}
          </StatusNotice>
        )}

        <button class="auth-button auth-button-block" type="submit" disabled={submitting}>
          <LucideIcon name={submitting ? 'loader-circle' : 'log-in'} className={submitting ? 'auth-spin' : ''} />
          {submitting ? 'Validando sesión…' : 'Entrar'}
        </button>
      </form>
    </AuthFrame>
  );
}

