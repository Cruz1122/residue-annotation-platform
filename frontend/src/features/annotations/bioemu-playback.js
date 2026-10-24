import { adjacentConformerIndex, clampConformerIndex } from './bioemu-presentation.js';

const MAX_UPDATE_FPS = 60;
const TARGET_UPDATE_INTERVAL_MS = 1000 / MAX_UPDATE_FPS;
const DEFAULT_SPEED = 4;

export function createBioEmuPlayback({
  frameCount,
  applyIndex = () => undefined,
  onTransition = () => undefined,
  onError = () => undefined,
  onIndex = () => undefined,
  onPlaying = () => undefined,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  initialIndex = 0,
  speed = DEFAULT_SPEED,
  loop = false,
  maxInterpolationSteps = MAX_UPDATE_FPS,
} = {}) {
  const count = Math.max(0, Math.trunc(Number(frameCount) || 0));
  let index = clampConformerIndex(initialIndex, count) ?? 0;
  let rate = Math.min(MAX_UPDATE_FPS, Math.max(0.1, Number(speed) || DEFAULT_SPEED));
  let looping = Boolean(loop);
  let playing = false;
  let disposed = false;
  let animationId = null;
  let lastTick = null;
  let nextUpdateAt = null;
  let elapsed = 0;
  let transitionProgress = 0;
  const maxSubsteps = Math.max(1, Math.trunc(Number(maxInterpolationSteps) || MAX_UPDATE_FPS));
  let updatePending = false;
  let queuedIndex = null;
  let queuedProgress = 0;
  let lastAppliedPosition = `${index}:0`;

  const notifyTransition = (fromIndex, progress) => {
    if (progress <= 0) {
      onTransition(null);
      return;
    }
    onTransition({
      fromIndex,
      toIndex: adjacentConformerIndex(fromIndex, count, 1, true),
    });
  };

  const safeApply = (nextIndex, progress = 0) => {
    const positionKey = `${nextIndex}:${Math.round(progress * maxSubsteps)}`;
    if (!updatePending && positionKey === lastAppliedPosition) return;
    if (updatePending) {
      queuedIndex = nextIndex;
      queuedProgress = progress;
      return;
    }
    try {
      lastAppliedPosition = positionKey;
      const result = applyIndex(nextIndex, progress);
      if (result && typeof result.then === 'function') {
        updatePending = true;
        Promise.resolve(result)
          .catch((error) => {
            if (disposed) return;
            queuedIndex = null;
            onError(error);
            stop();
          })
          .finally(() => {
            updatePending = false;
            if (!disposed && queuedIndex !== null && `${queuedIndex}:${queuedProgress}` !== lastAppliedPosition) {
              const latest = queuedIndex;
              const latestProgress = queuedProgress;
              queuedIndex = null;
              safeApply(latest, latestProgress);
            } else {
              queuedIndex = null;
            }
          });
      }
    } catch {
      if (disposed) return;
      queuedIndex = null;
      onError(new Error('No se pudo actualizar el conformero en Mol*.'));
      stop();
    }
  };

  const setIndexInternal = (candidate, { force = false } = {}) => {
    const nextIndex = clampConformerIndex(candidate, count);
    if (nextIndex === null) return false;
    const changed = nextIndex !== index || transitionProgress !== 0;
    if (!changed && !force) return false;
    index = nextIndex;
    elapsed = 0;
    transitionProgress = 0;
    notifyTransition(index, 0);
    onIndex(index);
    safeApply(index, 0);
    return true;
  };

  const schedule = () => {
    if (disposed || !playing || animationId !== null || typeof requestFrame !== 'function') return;
    animationId = requestFrame(tick);
  };

  const stop = ({ resetElapsed = false } = {}) => {
    if (!playing) return;
    playing = false;
    lastTick = null;
    nextUpdateAt = null;
    if (resetElapsed) elapsed = 0;
    if (animationId !== null && typeof cancelFrame === 'function') cancelFrame(animationId);
    animationId = null;
    onPlaying(false);
  };

  const tick = (timestamp) => {
    animationId = null;
    if (disposed || !playing) return;
    const time = Number.isFinite(timestamp) ? timestamp : now();
    if (lastTick === null) {
      lastTick = time;
      nextUpdateAt = time + TARGET_UPDATE_INTERVAL_MS;
    } else {
      const delta = Math.max(0, time - lastTick);
      lastTick = time;
      const duration = 1000 / rate;
      elapsed = Math.min(elapsed + delta, duration * 2);
      if (time + 1e-6 < nextUpdateAt) {
        schedule();
        return;
      }
      // Keep a stable update cadence on high-refresh displays, but skip missed
      // updates after a stalled/background tab instead of bursting to catch up.
      const overdueIntervals = Math.floor(Math.max(0, time - nextUpdateAt) / TARGET_UPDATE_INTERVAL_MS);
      nextUpdateAt += (overdueIntervals + 1) * TARGET_UPDATE_INTERVAL_MS;
      if (elapsed + 1e-6 >= duration) {
        // Carry the fractional remainder forward, while limiting each animation
        // tick to one source conformer even after a delayed browser frame.
        elapsed = Math.min(Math.max(0, elapsed - duration), duration);
        const nextIndex = adjacentConformerIndex(index, count, 1, looping);
        if (nextIndex === index) {
          transitionProgress = 0;
          notifyTransition(index, 0);
          safeApply(index, 0);
          stop({ resetElapsed: true });
          return;
        }
        index = nextIndex;
        transitionProgress = 0;
        notifyTransition(index, 0);
        onIndex(index);
        safeApply(index, 0);
        if (!looping && index === count - 1) {
          stop({ resetElapsed: true });
          return;
        }
      } else {
        const rawProgress = elapsed / duration;
        const progress = Math.round(rawProgress * maxSubsteps) / maxSubsteps;
        if (progress !== transitionProgress) {
          transitionProgress = progress;
          notifyTransition(index, progress);
          safeApply(index, progress);
        }
      }
    }
    schedule();
  };

  return {
    getIndex: () => index,
    getFrameCount: () => count,
    getSpeed: () => rate,
    getTransition: () => (transitionProgress > 0 ? {
      fromIndex: index,
      toIndex: adjacentConformerIndex(index, count, 1, true),
      progress: transitionProgress,
    } : null),
    isLooping: () => looping,
    isPlaying: () => playing,
    play() {
      if (disposed || playing || count < 2 || typeof requestFrame !== 'function') return;
      if (!looping && index >= count - 1) return;
      playing = true;
      lastTick = null;
      nextUpdateAt = null;
      elapsed = transitionProgress * (1000 / rate);
      onPlaying(true);
      schedule();
    },
    pause: stop,
    toggle() {
      if (playing) stop();
      else this.play();
    },
    setLoop(value) {
      const wasLooping = looping;
      looping = Boolean(value);
      if (wasLooping && !looping && count > 1 && index === count - 1 && transitionProgress > 0) {
        stop();
        elapsed = 0;
        transitionProgress = 0;
        notifyTransition(index, 0);
        safeApply(index, 0);
      }
    },
    setSpeed(value) {
      const nextSpeed = Number(value);
      if (!Number.isFinite(nextSpeed) || nextSpeed <= 0) return;
      rate = Math.min(MAX_UPDATE_FPS, nextSpeed);
      elapsed = transitionProgress * (1000 / rate);
      lastTick = null;
      nextUpdateAt = null;
    },
    setIndex(value) {
      stop();
      setIndexInternal(value, { force: true });
    },
    step(direction) {
      stop();
      setIndexInternal(adjacentConformerIndex(index, count, direction, looping));
    },
    reset() {
      stop();
      setIndexInternal(0, { force: true });
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      queuedIndex = null;
      if (animationId !== null && typeof cancelFrame === 'function') cancelFrame(animationId);
      animationId = null;
    },
  };
}
