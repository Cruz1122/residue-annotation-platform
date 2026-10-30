const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

function structureIsCommitted(canvas3d) {
  return (canvas3d?.boundingSphereVisible?.radius ?? 0) > 0
    && (canvas3d?.commitQueueSize?.value ?? 1) === 0;
}

function structureIsVisible(canvas3d) {
  return (canvas3d?.boundingSphereVisible?.radius ?? 0) > 0;
}

/** Wait until Mol* has committed and drawn a molecular structure at least once. */
export function waitForCanvasDraw(canvas3d, {
  signal,
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
  requireNewDraw = false,
  drawBaseline,
} = {}) {
  if (signal?.aborted) return Promise.resolve();
  if (!canvas3d?.didDraw?.subscribe || !canvas3d?.commitQueueSize || !canvas3d?.boundingSphereVisible) {
    return Promise.reject(new Error('Mol* no expuso el estado de renderizado de la estructura.'));
  }

  const previousDraw = canvas3d.didDraw.value;
  const baseline = Number.isFinite(drawBaseline) ? drawBaseline : previousDraw;
  return new Promise((resolve, reject) => {
    // Structure loading can commit and draw the molecular scene before this
    // helper is installed. In that case the current canvas state is already
    // valid; waiting for a second draw can hang when the browser throttles an
    // otherwise visible Mol* canvas.
    let sawDraw = Number.isFinite(previousDraw)
      && (Number.isFinite(drawBaseline)
        ? previousDraw !== baseline && structureIsVisible(canvas3d)
        : !requireNewDraw && previousDraw > 0);
    let didDrawSubscription;
    let commitQueueSubscription;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error('Mol* no alcanzó a dibujar la estructura publicada.'));
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      didDrawSubscription?.unsubscribe?.();
      commitQueueSubscription?.unsubscribe?.();
      signal?.removeEventListener?.('abort', abort);
      if (error) reject(error);
      else resolve();
    }

    function checkReady() {
      if (sawDraw && structureIsCommitted(canvas3d)) finish();
    }

    function abort() {
      finish();
    }

    didDrawSubscription = canvas3d.didDraw.subscribe((timestamp) => {
      if (timestamp !== baseline && structureIsVisible(canvas3d)) sawDraw = true;
      queueMicrotask(checkReady);
    });
    commitQueueSubscription = canvas3d.commitQueueSize.subscribe(() => queueMicrotask(checkReady));
    signal?.addEventListener?.('abort', abort, { once: true });
    canvas3d.requestResize?.();
    canvas3d.requestDraw?.();
    checkReady();
  });
}
