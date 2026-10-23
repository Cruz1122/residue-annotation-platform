import { useEffect, useRef, useState } from 'preact/hooks';
import { verifyEmail } from '@shared/api/client';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { AuthFrame, LoadingState, StatusNotice } from './AuthFrame';
import { authErrorMessage, consumeUrlValue } from '../lib/ui';

type VerificationState = 'checking' | 'error' | 'missing' | 'success';

export default function VerifyEmailView() {
  const [state, setState] = useState<VerificationState>('checking');
  const [error, setError] = useState('');
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    const token = consumeUrlValue('token');
    if (!token) {
      setState('missing');
      return;
    }

    void verifyEmail(token)
      .then(() => setState('success'))
      .catch((requestError: unknown) => {
        setError(authErrorMessage(requestError, 'No fue posible verificar el correo.', {
          400: 'El enlace de verificación no es válido, ya fue utilizado o expiró.',
        }));
        setState('error');
      });
  }, []);

  return (
    <AuthFrame
      title="Confirmar correo"
      footer={<a class="auth-link" href="/auth/login/">Volver al inicio de sesión</a>}
    >
      {state === 'checking' && <LoadingState label="Verificando enlace…" />}
      {state === 'missing' && (
        <div class="auth-success">
          <StatusNotice kind="error">El enlace no contiene un token de verificación.</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/request-verification/">Solicitar un enlace nuevo</a>
        </div>
      )}
      {state === 'error' && (
        <div class="auth-success">
          <StatusNotice kind="error">{error}</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/request-verification/">Solicitar un enlace nuevo</a>
        </div>
      )}
      {state === 'success' && (
        <div class="auth-success">
          <StatusNotice kind="success">Tu correo fue verificado. Ya puedes iniciar sesión.</StatusNotice>
          <a class="auth-button auth-button-block" href="/auth/login/">
            <PackIcon name="log-in" kind="ui" />
            Iniciar sesión
          </a>
        </div>
      )}
    </AuthFrame>
  );
}
