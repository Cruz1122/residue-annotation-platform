import { useState } from 'preact/hooks';
import { changePassword } from '@shared/api/client';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { AuthFrame, StatusNotice } from './AuthFrame';
import { PasswordField } from './PasswordField';
import { authErrorMessage, passwordValidation } from '../lib/ui';

export default function ChangePasswordView() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: Event) => {
    event.preventDefault();
    const validationError = passwordValidation(password, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!currentPassword) {
      setError('Escribe tu contraseña actual.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await changePassword(currentPassword, password);
      setCompleted(true);
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
    } catch (requestError) {
      setError(authErrorMessage(requestError, 'No fue posible cambiar la contraseña.', {
        401: 'La contraseña actual no es correcta.',
      }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Cambiar contraseña"
      footer={<a class="auth-link" href="/auth/session/">Volver a tu cuenta</a>}
    >
      <form class="auth-form" onSubmit={submit}>
        {completed && <StatusNotice kind="success">La contraseña fue actualizada y la sesión quedó renovada.</StatusNotice>}
        <PasswordField
          id="current-password"
          name="current-password"
          label="Contraseña actual"
          value={currentPassword}
          onInput={setCurrentPassword}
          autoComplete="current-password"
          placeholder="••••••••••••"
          disabled={submitting}
        />
        <PasswordField
          id="new-password"
          name="new-password"
          label="Contraseña nueva"
          value={password}
          onInput={setPassword}
          autoComplete="new-password"
          describedBy="change-password-help"
          placeholder="Mínimo 12 caracteres"
          minLength={12}
          disabled={submitting}
        />
        <p id="change-password-help" class="auth-field-help">Entre 12 y 128 caracteres; sin espacios al inicio o al final.</p>
        <PasswordField
          id="new-password-confirmation"
          name="new-password-confirmation"
          label="Confirmar contraseña nueva"
          value={confirmation}
          onInput={setConfirmation}
          autoComplete="new-password"
          placeholder="Repite la contraseña nueva"
          minLength={12}
          disabled={submitting}
        />
        {error && <StatusNotice kind="error">{error}</StatusNotice>}
        <button class="auth-button auth-button-block" type="submit" disabled={submitting}>
          <PackIcon name={submitting ? 'loader-circle' : 'key-round'} kind="ui" className={submitting ? 'auth-spin' : ''} />
          {submitting ? 'Actualizando…' : 'Actualizar contraseña'}
        </button>
      </form>
    </AuthFrame>
  );
}
