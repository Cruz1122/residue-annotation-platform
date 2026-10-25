/** Avoid temporal multisample accumulation, the dominant zoom cost in Mol*. */
export function getZoomOptimizedCanvas3dProps() {
  return { multiSample: { mode: 'off' } };
}
