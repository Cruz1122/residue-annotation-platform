import type {
  AnnotationResponse,
  CreateProteinInput,
  CreateRunInput,
  HealthResponse,
  Protein,
  Run,
  StageDefinition,
  Upload,
} from '@shared/types/domain';
import { createInFlightPromiseCache } from './in-flight-promise-cache.js';
import {
  clearAuthSession,
  parseAuthTokenPayload,
  parseAuthUser,
  readAuthSession,
  safeInternalPath,
  storeAuthSession,
  updateStoredUser,
  type AuthSession,
  type AuthTokenPayload,
  type AuthUser,
  type UserRole,
} from '@shared/auth/session';

const configuredBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:8742/api/v1';
const apiBaseUrl = configuredBaseUrl.replace(/\/$/, '');
const ACCESS_REFRESH_MARGIN_MS = 10_000;

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  readonly activeRunId: string | null;
  readonly activeProteinId: string | null;
  readonly code: string | null;

  constructor(
    message: string,
    status: number,
    retryAfter: number | null = null,
    activeRun: { runId: string; proteinId: string } | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.activeRunId = activeRun?.runId ?? null;
    this.activeProteinId = activeRun?.proteinId ?? null;
    this.code = code;
  }
}

type AuthMode = 'required' | 'optional' | 'none';
type RequestOptions = RequestInit & {
  json?: unknown;
  auth?: AuthMode;
  retryAuth?: boolean;
};

export interface ActionResponse {
  message: string;
  verification_token?: string | null;
  reset_token?: string | null;
}

export interface VerifyEmailResponse {
  message: string;
  user: AuthUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function validationDetail(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null;
  for (const item of detail) {
    if (isRecord(item) && typeof item.msg === 'string') return item.msg;
  }
  return null;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;
  const detail = isRecord(payload) ? payload.detail : null;
  if (isRecord(detail)) {
    const message = typeof detail.message === 'string' ? detail.message : `HTTP ${response.status}`;
    const runId = typeof detail.run_id === 'string' ? detail.run_id : '';
    const proteinId = typeof detail.protein_id === 'string' ? detail.protein_id : '';
    const code = typeof detail.code === 'string' ? detail.code : null;
    return new ApiError(
      message,
      response.status,
      parseRetryAfter(response),
      runId && proteinId ? { runId, proteinId } : null,
      code,
    );
  }
  const message = typeof detail === 'string'
    ? detail
    : validationDetail(detail) ?? `HTTP ${response.status}`;
  return new ApiError(message, response.status, parseRetryAfter(response));
}

function redirectToLogin(): void {
  if (typeof window === 'undefined' || /^\/auth\/login\/?$/.test(window.location.pathname)) return;
  const next = safeInternalPath(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    '/proteins/',
  );
  window.location.assign(`/auth/login/?next=${encodeURIComponent(next)}`);
}

function expireFrontendSession(): void {
  clearAuthSession();
  redirectToLogin();
}

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

let refreshPromise: Promise<AuthSession | null> | null = null;
const inFlightReadRequests = createInFlightPromiseCache();
const inFlightArtifactBlobs = createInFlightPromiseCache();

async function fetchResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  const {
    json,
    auth = 'required',
    retryAuth = true,
    headers: inputHeaders,
    ...requestInit
  } = options;
  let session = auth === 'none' ? null : readAuthSession();

  if (
    retryAuth
    && session
    && session.expiresAt <= Date.now() + ACCESS_REFRESH_MARGIN_MS
  ) {
    try {
      session = await refreshAuthSession();
    } catch {
      expireFrontendSession();
      throw new ApiError('Tu sesión expiró. Inicia sesión de nuevo.', 401);
    }
  }

  if (auth === 'required' && !session) {
    redirectToLogin();
    throw new ApiError('Debes iniciar sesión para continuar.', 401);
  }

  const headers = new Headers(inputHeaders);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  if (session) headers.set('Authorization', `Bearer ${session.accessToken}`);

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...requestInit,
      headers,
      body: json === undefined ? requestInit.body : JSON.stringify(json),
    });
  } catch {
    throw new ApiError('No se pudo conectar con el backend.', 0);
  }

  if (response.status === 401 && retryAuth && auth !== 'none' && session?.refreshToken) {
    try {
      const refreshed = await refreshAuthSession();
      if (refreshed) return fetchResponse(path, { ...options, retryAuth: false });
    } catch {
      // The common session-expiry path below clears all local credentials.
    }
    expireFrontendSession();
    throw new ApiError('Tu sesión expiró. Inicia sesión de nuevo.', 401);
  }

  if (!response.ok) {
    if (response.status === 401 && auth === 'required') expireFrontendSession();
    throw await errorFromResponse(response);
  }
  return response;
}

async function requestOnce<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetchResponse(path, options);
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError('El backend devolvió una respuesta inesperada.', 502);
  }
  return await response.json() as T;
}

function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const canShare = method.toUpperCase() === 'GET'
    && Object.entries(options).every(([key, value]) => (
      value === undefined || key === 'auth' || key === 'retryAuth'
    ));
  if (!canShare) return requestOnce<T>(path, options);

  const auth = options.auth ?? 'required';
  const session = auth === 'none' ? null : readAuthSession();
  const key = JSON.stringify([
    apiUrl(path),
    auth,
    options.retryAuth ?? true,
    session?.user.id ?? '',
    session?.accessToken ?? '',
  ]);
  return inFlightReadRequests.getOrCreate(key, () => requestOnce<T>(path, options)) as Promise<T>;
}

function requireActionResponse(payload: unknown): ActionResponse {
  if (!isRecord(payload) || typeof payload.message !== 'string') {
    throw new ApiError('El backend devolvió una respuesta de autenticación inválida.', 502);
  }
  return {
    message: payload.message,
    verification_token: typeof payload.verification_token === 'string' ? payload.verification_token : null,
    reset_token: typeof payload.reset_token === 'string' ? payload.reset_token : null,
  };
}

function requireTokenPayload(payload: unknown): AuthTokenPayload {
  const parsed = parseAuthTokenPayload(payload);
  if (!parsed) throw new ApiError('El backend devolvió una sesión inválida.', 502);
  return parsed;
}

function persistTokenPayload(payload: unknown): AuthSession {
  const session = storeAuthSession(requireTokenPayload(payload));
  if (!readAuthSession()) {
    throw new ApiError('El navegador bloqueó el almacenamiento de la sesión.', 0);
  }
  return session;
}

async function rotateRefreshToken(): Promise<AuthSession | null> {
  const current = readAuthSession();
  if (!current) return null;
  try {
    const payload = await request<unknown>('/auth/refresh', {
      method: 'POST',
      json: { refresh_token: current.refreshToken },
      auth: 'none',
      retryAuth: false,
    });
    return persistTokenPayload(payload);
  } catch (error) {
    clearAuthSession();
    throw error;
  }
}

export function refreshAuthSession(): Promise<AuthSession | null> {
  if (!refreshPromise) {
    refreshPromise = rotateRefreshToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const payload = await request<unknown>('/auth/login', {
    method: 'POST',
    json: { email, password },
    auth: 'none',
  });
  return persistTokenPayload(payload);
}

export async function registerAccount(email: string, password: string): Promise<ActionResponse> {
  return requireActionResponse(await request<unknown>('/auth/register', {
    method: 'POST',
    json: { email, password },
    auth: 'none',
  }));
}

export async function requestEmailVerification(email: string): Promise<ActionResponse> {
  return requireActionResponse(await request<unknown>('/auth/verify-email/request', {
    method: 'POST',
    json: { email },
    auth: 'none',
  }));
}

export async function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  const payload = await request<unknown>('/auth/verify-email', {
    method: 'POST',
    json: { token },
    auth: 'none',
  });
  if (!isRecord(payload) || typeof payload.message !== 'string') {
    throw new ApiError('El backend devolvió una verificación inválida.', 502);
  }
  const user = parseAuthUser(payload.user);
  if (!user) throw new ApiError('El backend devolvió un usuario inválido.', 502);
  return { message: payload.message, user };
}

export async function requestPasswordReset(email: string): Promise<ActionResponse> {
  return requireActionResponse(await request<unknown>('/auth/reset-password', {
    method: 'POST',
    json: { email },
    auth: 'none',
  }));
}

export async function confirmPasswordReset(token: string, password: string): Promise<ActionResponse> {
  return requireActionResponse(await request<unknown>('/auth/reset-password/confirm', {
    method: 'POST',
    json: { token, password },
    auth: 'none',
  }));
}

export async function changePassword(currentPassword: string, password: string): Promise<AuthSession> {
  const payload = await request<unknown>('/auth/change-password', {
    method: 'POST',
    json: { current_password: currentPassword, password },
  });
  return persistTokenPayload(payload);
}

export async function getCurrentUser(): Promise<AuthUser> {
  const payload = await request<unknown>('/auth/me');
  if (!isRecord(payload)) throw new ApiError('El backend devolvió un usuario inválido.', 502);
  const user = parseAuthUser(payload.user);
  if (!user) throw new ApiError('El backend devolvió un usuario inválido.', 502);
  updateStoredUser(user);
  return user;
}

export async function logout(): Promise<void> {
  const current = readAuthSession();
  try {
    await request<unknown>('/auth/logout', {
      method: 'POST',
      json: { refresh_token: current?.refreshToken ?? null },
      auth: 'optional',
      retryAuth: false,
    });
  } finally {
    clearAuthSession();
  }
}

export async function listAuthUsers(): Promise<AuthUser[]> {
  const payload = await request<unknown>('/auth/users');
  if (!Array.isArray(payload)) throw new ApiError('El backend devolvió una lista de usuarios inválida.', 502);
  const users = payload.map(parseAuthUser);
  if (users.some((user) => !user)) throw new ApiError('El backend devolvió un usuario inválido.', 502);
  return users as AuthUser[];
}

export async function updateUserRole(userId: string, role: UserRole): Promise<AuthUser> {
  const payload = await request<unknown>(`/auth/users/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    json: { role },
  });
  const user = parseAuthUser(payload);
  if (!user) throw new ApiError('El backend devolvió un usuario inválido.', 502);
  const current = readAuthSession();
  if (current?.user.id === user.id) clearAuthSession();
  return user;
}

export async function getHealth(): Promise<HealthResponse> {
  const payload = await request<unknown>('/health', { auth: 'none' });
  if (!isRecord(payload) || payload.status !== 'ok') {
    throw new ApiError('El backend devolvió un health inválido.', 502);
  }
  return { status: 'ok' };
}

export function listProteins(): Promise<Protein[]> {
  return request<Protein[]>('/proteins');
}

export function getProtein(id: string): Promise<Protein> {
  return request<Protein>(`/proteins/${encodeURIComponent(id)}`);
}

export function createProtein(input: CreateProteinInput): Promise<Protein> {
  return request<Protein>('/proteins', { method: 'POST', json: input });
}

export function createRun(input: CreateRunInput, idempotencyKey?: string): Promise<Run> {
  return request<Run>('/runs', {
    method: 'POST',
    json: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
}

export function uploadInput(file: File, inputType: 'fasta' | 'structure'): Promise<Upload> {
  const form = new FormData();
  form.append('file', file);
  form.append('input_type', inputType);
  return request<Upload>('/uploads', { method: 'POST', body: form });
}

export function getActiveRun(): Promise<Run> {
  return request<Run>('/runs/active');
}

export function getRun(runId: string): Promise<Run> {
  return request<Run>(`/runs/${encodeURIComponent(runId)}`);
}

export function listRuns(
  limit = 200,
  offset = 0,
  filters: { baseProteinId?: string } = {},
): Promise<Run[]> {
  const boundedLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const boundedOffset = Math.max(0, Math.trunc(offset));
  const params = new URLSearchParams({ limit: String(boundedLimit), offset: String(boundedOffset) });
  if (filters.baseProteinId) params.set('base_protein_id', filters.baseProteinId);
  return request<Run[]>(`/runs?${params.toString()}`);
}

function parseRunSnapshot(value: unknown): Run {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string' || !Array.isArray(value.stages)) {
    throw new ApiError('El backend devolvió un snapshot de corrida inválido.', 502);
  }
  return value as unknown as Run;
}

export async function subscribeRunEvents(
  runId: string,
  options: { onSnapshot: (run: Run) => void; signal?: AbortSignal },
): Promise<void> {
  const response = await fetchResponse(`/runs/${encodeURIComponent(runId)}/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: options.signal,
  });
  if (!response.body) throw new ApiError('El navegador no soporta eventos de corrida.', 501);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const consumeFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const encoded = dataLines.join('\n');
    dataLines = [];
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(encoded);
    } catch {
      throw new ApiError('El backend devolvió un evento de corrida inválido.', 502);
    }
    options.onSnapshot(parseRunSnapshot(snapshot));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) consumeFrame(frame);
      if (done) break;
    }
    if (buffer) consumeFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function cancelRun(runId: string): Promise<Run> {
  return request<Run>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

export function getStageDefinitions(): Promise<StageDefinition[]> {
  return request<StageDefinition[]>('/stages');
}

export function getAnnotations(runId: string, limit?: number, offset = 0): Promise<AnnotationResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(Math.min(50_000, Math.max(1, Math.trunc(limit)))));
  if (offset > 0) params.set('offset', String(Math.trunc(offset)));
  const query = params.toString();
  return request<AnnotationResponse>(`/runs/${encodeURIComponent(runId)}/annotations${query ? `?${query}` : ''}`);
}

export function getArtifactBlob(
  artifactId: string,
  exportFormat: 'original' | 'xlsx' = 'original',
  options: { signal?: AbortSignal; onProgress?: (progress: { loaded: number; total: number | null; complete?: boolean }) => void } = {},
): Promise<Blob> {
  // The artifact endpoint may negotiate a spreadsheet for tabular files when
  // the format is omitted. Analysis views need the published TSV/CSV bytes so
  // their parsers must request the original representation explicitly.
  const query = `?format=${exportFormat}`;
  const path = `/artifacts/${encodeURIComponent(artifactId)}/content${query}`;
  const load = async (): Promise<Blob> => {
    const response = await fetchResponse(path, { signal: options.signal });
    if (!options.onProgress || !response.body) return await response.blob();

    const rawLength = Number(response.headers.get('content-length'));
    const total = Number.isFinite(rawLength) && rawLength >= 0 ? rawLength : null;
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
        loaded += value.byteLength;
        options.onProgress({ loaded, total });
      }
    } finally {
      reader.releaseLock();
    }
    options.onProgress({ loaded, total, complete: true });
    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
  };

  // Abortable and progress-reporting reads have caller-specific lifetimes, so
  // only share ordinary reads. This keeps duplicate artifact downloads from
  // competing views down to one request without coupling cancellation states.
  if (options.signal || options.onProgress) return load();
  const session = readAuthSession();
  const key = JSON.stringify([apiUrl(path), session?.user.id ?? '', session?.accessToken ?? '']);
  return inFlightArtifactBlobs.getOrCreate(key, load) as Promise<Blob>;
}

export async function getArtifactObjectUrl(
  artifactId: string,
  exportFormat: 'original' | 'xlsx' = 'original',
): Promise<string> {
  return URL.createObjectURL(await getArtifactBlob(artifactId, exportFormat));
}

export async function getUploadBlob(uploadId: string): Promise<Blob> {
  const response = await fetchResponse(`/uploads/${encodeURIComponent(uploadId)}/content`);
  return await response.blob();
}

export async function getUploadObjectUrl(uploadId: string): Promise<string> {
  return URL.createObjectURL(await getUploadBlob(uploadId));
}
