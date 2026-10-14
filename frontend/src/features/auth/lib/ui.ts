import { ApiError } from '@shared/api/client';

const DEFAULT_STATUS_MESSAGES: Record<number, string> = {
  0: 'No se pudo conectar con el backend. Verifica que el servicio esté disponible.',
  400: 'La solicitud no es válida. Revisa los datos e inténtalo de nuevo.',
  401: 'La sesión o las credenciales no son válidas.',
  403: 'No tienes permiso para realizar esta acción.',
  404: 'No se encontró el recurso solicitado.',
  409: 'La operación entra en conflicto con el estado actual de la cuenta.',
  422: 'Revisa los campos marcados e inténtalo de nuevo.',
  429: 'Se alcanzó el límite de intentos. Espera un momento antes de volver a intentar.',
};

export function authErrorMessage(
  error: unknown,
  fallback: string,
  overrides: Partial<Record<number, string>> = {},
): string {
  if (!(error instanceof ApiError)) return fallback;
  return overrides[error.status] ?? DEFAULT_STATUS_MESSAGES[error.status] ?? fallback;
}

export function passwordValidation(password: string, confirmation: string): string | null {
  if (password.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (password.length > 128) return 'La contraseña no puede superar 128 caracteres.';
  if (password.trim() !== password) return 'La contraseña no puede empezar ni terminar con espacios.';
  if (password !== confirmation) return 'Las contraseñas no coinciden.';
  return null;
}

export function queryValue(name: string): string {
  if (typeof window === 'undefined') return '';
  const queryValue = new URLSearchParams(window.location.search).get(name)?.trim();
  if (queryValue) return queryValue;
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get(name)?.trim() ?? '';
}

export function consumeUrlValue(name: string): string {
  if (typeof window === 'undefined') return '';
  const value = queryValue(name);
  if (!value) return '';

  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  fragment.delete(name);
  url.hash = fragment.size > 0 ? fragment.toString() : '';
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return value;
}
