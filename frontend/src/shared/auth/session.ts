export type UserRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  email: string;
  project_id: string;
  role: UserRole;
  email_verified: boolean;
  is_active: boolean;
  created_at: string | null;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

export interface AuthTokenPayload {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  user: AuthUser;
}

const STORAGE_KEY = 'residue-annotation-auth-v1';
const SESSION_EVENT = 'residue-annotation:session-change';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'user';
}

export function parseAuthUser(value: unknown): AuthUser | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.email !== 'string'
    || typeof value.project_id !== 'string'
    || !isUserRole(value.role)
    || typeof value.email_verified !== 'boolean'
    || typeof value.is_active !== 'boolean'
    || (value.created_at !== null && value.created_at !== undefined && typeof value.created_at !== 'string')
  ) return null;

  return {
    id: value.id,
    email: value.email,
    project_id: value.project_id,
    role: value.role,
    email_verified: value.email_verified,
    is_active: value.is_active,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
  };
}

export function parseAuthTokenPayload(value: unknown): AuthTokenPayload | null {
  if (!isRecord(value)) return null;
  const user = parseAuthUser(value.user);
  if (
    !user
    || typeof value.access_token !== 'string'
    || !value.access_token
    || typeof value.refresh_token !== 'string'
    || !value.refresh_token
    || value.token_type !== 'bearer'
    || typeof value.expires_in !== 'number'
    || !Number.isFinite(value.expires_in)
    || value.expires_in <= 0
  ) return null;

  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    token_type: 'bearer',
    expires_in: value.expires_in,
    user,
  };
}

function parseStoredSession(value: unknown): AuthSession | null {
  if (!isRecord(value)) return null;
  const user = parseAuthUser(value.user);
  if (
    !user
    || typeof value.accessToken !== 'string'
    || !value.accessToken
    || typeof value.refreshToken !== 'string'
    || !value.refreshToken
    || typeof value.expiresAt !== 'number'
    || !Number.isFinite(value.expiresAt)
  ) return null;

  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    user,
  };
}

function emitSessionChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EVENT));
}

function availableStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readAuthSession(): AuthSession | null {
  const storage = availableStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = parseStoredSession(JSON.parse(raw) as unknown);
    if (!session) storage.removeItem(STORAGE_KEY);
    return session;
  } catch {
    return null;
  }
}

export function storeAuthSession(payload: AuthTokenPayload): AuthSession {
  const session: AuthSession = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    user: payload.user,
  };
  const storage = availableStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(session));
      emitSessionChange();
    } catch {
      // Storage can be disabled by browser privacy settings. The caller still
      // receives the in-memory response, but protected navigation fails closed.
    }
  }
  return session;
}

export function updateStoredUser(user: AuthUser): void {
  const current = readAuthSession();
  const storage = availableStorage();
  if (!current || !storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...current, user }));
    emitSessionChange();
  } catch {
    // Fail closed when storage is unavailable.
  }
}

export function clearAuthSession(): void {
  const storage = availableStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
    emitSessionChange();
  } catch {
    // There is no persisted session to trust when storage is unavailable.
  }
}

export function subscribeAuthSession(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(SESSION_EVENT, listener);
  return () => window.removeEventListener(SESSION_EVENT, listener);
}

export function safeInternalPath(value: string | null | undefined, fallback = '/proteins/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const parsed = new URL(value, 'http://local.invalid');
    if (parsed.origin !== 'http://local.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
