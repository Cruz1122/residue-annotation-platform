export function withViewTransition(update) {
  if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
    return document.startViewTransition(update);
  }
  update();
  return null;
}
