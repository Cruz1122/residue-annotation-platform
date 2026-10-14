import { useState } from 'preact/hooks';
import { ApiError, registerAccount } from '@shared/api/client';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AuthFrame, StatusNotice } from './AuthFrame';
import { PasswordField } from './PasswordField';
import { authErrorMessage, passwordValidation } from '../lib/ui';

export default function RegisterView() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [verificationToken, setVerificationToken] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: Event) => {
    event.preventDefault();
    const validationError = passwordValidation(password, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const response = await registerAccount(email, password);
      setVerificationToken(response.verification_token ?? '');
      setCompleted(true);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 503) {
        // The backend commits the account before contacting the provider so a
        // transient Resend failure never discards the account or its token.
        setVerificationToken('');
        setCompleted(true);
        return;
      }
      setError(authErrorMessage(requestError, 'No fue posible crear la cuenta.', {
        409: 'Ya existe una cuenta registrada con este correo.',
      }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Crear cuenta"
      footer={<><span>¿Ya tienes una cuenta?</span><a class="auth-link" href="/auth/login/">Iniciar sesión</a></>}
    >
      {completed ? (
        <div class="auth-success">
          <StatusNotice kind="success">
            <p>La cuenta fue creada. Debes verificar el correo antes de iniciar sesión.</p>
          </StatusNotice>
          <div class="auth-success-actions">
            {verificationToken ? (
              <a class="auth-button auth-button-block" href={`/auth/verify-email/#token=${encodeURIComponent(verificationToken)}`}>
                <LucideIcon name="mail-check" />
                Verificar ahora
              </a>
            ) : (
              <a class="auth-button auth-button-block" href={`/auth/request-verification/?email=${encodeURIComponent(email)}`}>
                Solicitar otro correo
              </a>
            )}
            <a class="auth-button auth-button-secondary auth-button-block" href="/auth/login/">Ir al inicio de sesión</a>
          </div>
          {verificationToken && (
            <p class="auth-field-help">El acceso directo se muestra únicamente cuando el backend entrega el token en desarrollo.</p>
          )}
        </div>
      ) : (
        <form class="auth-form" onSubmit={submit}>
          <label class="auth-field" for="register-email">
            <span>Correo electrónico</span>
            <input
              id="register-email"
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
            id="register-password"
            name="password"
            label="Contraseña"
            value={password}
            onInput={setPassword}
            autoComplete="new-password"
            describedBy="register-password-help"
            placeholder="Mínimo 12 caracteres"
            minLength={12}
            disabled={submitting}
          />
          <p id="register-password-help" class="auth-field-help">Entre 12 y 128 caracteres; sin espacios al inicio o al final.</p>

          <PasswordField
            id="register-confirmation"
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
            <LucideIcon name={submitting ? 'loader-circle' : 'user-round-plus'} className={submitting ? 'auth-spin' : ''} />
            {submitting ? 'Creando cuenta…' : 'Crear cuenta de usuario'}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
