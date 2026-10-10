const KEY = 'protein-pipeline-demo-session-v1';

export const EMPTY_SESSION = {
  uploaded: null,
  variants: [],
  runStartedAt: null,
};

export function readSession() {
  if (typeof sessionStorage === 'undefined') return { ...EMPTY_SESSION };
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) || '{}');
    return {
      ...EMPTY_SESSION,
      ...parsed,
      variants: Array.isArray(parsed.variants) ? parsed.variants : [],
    };
  } catch {
    return { ...EMPTY_SESSION };
  }
}

export function writeSession(patch) {
  if (typeof sessionStorage === 'undefined') return { ...EMPTY_SESSION, ...patch };
  const next = { ...readSession(), ...patch };
  sessionStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSession() {
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(KEY);
}
