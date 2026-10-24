import assert from 'node:assert/strict';
import test from 'node:test';
import { createBioEmuPlayback } from './bioemu-playback.js';

const RAF_INTERVAL = 1000 / 60;

function fakeAnimationFrames() {
  let nextId = 0;
  const pending = new Map();
  const cancelled = [];
  return {
    requestFrame(callback) {
      nextId += 1;
      pending.set(nextId, callback);
      return nextId;
    },
    cancelFrame(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    pending,
    cancelled,
    tick(timestamp) {
      const first = pending.entries().next().value;
      assert.ok(first, 'expected a scheduled animation frame');
      const [id, callback] = first;
      pending.delete(id);
      callback(timestamp);
    },
  };
}

function createController(clock, options = {}) {
  return createBioEmuPlayback({
    frameCount: 4,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    ...options,
  });
}

function runTicks(clock, firstTimestamp, count) {
  for (let tick = 0; tick < count; tick += 1) {
    clock.tick(firstTimestamp + tick * RAF_INTERVAL);
  }
}

test('pause preserves the exact interpolated position and resume continues from it', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    speed: 4,
    applyIndex: (index, progress) => applied.push([index, progress]),
  });
  controller.setIndex(1);
  controller.play();
  clock.tick(0);
  clock.tick(RAF_INTERVAL);

  assert.equal(controller.getIndex(), 1, 'the published sample index stays on the source until the endpoint');
  assert.equal(controller.getTransition().toIndex, 2);
  assert.ok(Math.abs(controller.getTransition().progress - 1 / 15) < 0.000001);
  controller.pause();
  assert.equal(controller.getTransition().progress, 1 / 15);
  assert.equal(clock.pending.size, 0);

  controller.play();
  clock.tick(1000);
  clock.tick(1000 + RAF_INTERVAL);
  assert.ok(Math.abs(controller.getTransition().progress - 2 / 15) < 0.000001);
  assert.deepEqual(applied, [[1, 0], [1, 1 / 15], [1, 2 / 15]]);
  controller.dispose();
});

test('loop playback interpolates the last conformer back to the first without reloading the trajectory', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    frameCount: 2,
    speed: 30,
    loop: true,
    applyIndex: (index, progress) => applied.push([index, progress]),
  });
  controller.play();
  clock.tick(0);
  runTicks(clock, RAF_INTERVAL, 2);
  assert.equal(controller.getIndex(), 1);
  assert.equal(controller.getTransition(), null);
  runTicks(clock, RAF_INTERVAL * 3, 2);
  assert.equal(controller.getIndex(), 0);
  assert.equal(controller.getTransition(), null);
  assert.deepEqual(applied, [[0, 0.5], [1, 0], [1, 0.5], [0, 0]]);
  assert.equal(clock.pending.size, 1);
  controller.pause();
  controller.dispose();
});

test('turning the loop off during last-to-first interpolation restores and pauses on the last exact conformer', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    frameCount: 2,
    speed: 30,
    loop: true,
    applyIndex: (index, progress) => applied.push([index, progress]),
  });
  controller.play();
  clock.tick(0);
  runTicks(clock, RAF_INTERVAL, 3);

  assert.equal(controller.getIndex(), 1);
  assert.equal(controller.getTransition().toIndex, 0);
  controller.setLoop(false);

  assert.equal(controller.isPlaying(), false);
  assert.equal(controller.getIndex(), 1);
  assert.equal(controller.getTransition(), null);
  assert.deepEqual(applied.slice(-2), [[1, 0.5], [1, 0]]);
  assert.equal(clock.pending.size, 0);
  controller.dispose();
});

test('playback stops at the final exact conformer when looping is disabled', () => {
  const clock = fakeAnimationFrames();
  const playingChanges = [];
  const controller = createController(clock, {
    frameCount: 3,
    speed: 30,
    onPlaying: (value) => playingChanges.push(value),
  });
  controller.play();
  clock.tick(0);
  runTicks(clock, RAF_INTERVAL, 4);
  assert.equal(controller.getIndex(), 2);
  assert.equal(controller.getTransition(), null);
  assert.equal(controller.isPlaying(), false);
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(playingChanges, [true, false]);
  controller.dispose();
});

test('changing speed preserves one animation loop and the current visual interpolation position', () => {
  const clock = fakeAnimationFrames();
  const controller = createController(clock, { frameCount: 207, speed: 30 });
  controller.play();
  assert.equal(clock.pending.size, 1);
  clock.tick(0);
  clock.tick(RAF_INTERVAL);
  const previousProgress = controller.getTransition().progress;
  controller.setSpeed(16);
  controller.play();
  assert.equal(controller.getSpeed(), 16);
  assert.equal(controller.getTransition().progress, previousProgress);
  clock.tick(1000);
  clock.tick(1000 + RAF_INTERVAL);
  assert.ok(controller.getTransition().progress > previousProgress);
  assert.equal(clock.pending.size, 1);
  controller.dispose();
});

test('playback rate matches conformers per second at a stable 60 Hz display rate', () => {
  for (const speed of [1, 2, 4, 8, 16, 30, 60]) {
    const clock = fakeAnimationFrames();
    const applied = [];
    const controller = createController(clock, {
      frameCount: 1000,
      speed,
      applyIndex: (index, progress) => applied.push(index + progress),
    });
    controller.play();
    clock.tick(0);
    for (let frame = 1; frame <= 180; frame += 1) clock.tick(frame * RAF_INTERVAL);

    const transition = controller.getTransition();
    const position = controller.getIndex() + (transition?.progress ?? 0);
    assert.ok(Math.abs(position - speed * 3) < 0.02, `${speed} conformeros/s avanzó ${position / 3} conformeros/s`);
    assert.ok(applied.length <= 180, 'se inicia como máximo una actualización Mol* por tick');
    controller.dispose();
  }
});

test('Mol* frame updates stay at or below 60 per second on a 120 Hz display', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    frameCount: 1000,
    speed: 4,
    applyIndex: (index, progress) => applied.push(index + progress),
  });
  controller.play();
  clock.tick(0);
  for (let frame = 1; frame <= 360; frame += 1) clock.tick(frame * (1000 / 120));

  const transition = controller.getTransition();
  const position = controller.getIndex() + (transition?.progress ?? 0);
  assert.ok(Math.abs(position - 12) < 0.02, `120 Hz display advanced ${position / 3} conformeros/s`);
  assert.ok(applied.length <= 180, `Mol* received ${applied.length / 3} updates/s`);
  controller.dispose();
});

test('a delayed background tick drops its backlog instead of bursting Mol* updates on resume', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    frameCount: 1000,
    speed: 4,
    applyIndex: (index, progress) => applied.push([index, progress]),
  });
  controller.play();
  clock.tick(0);
  clock.tick(1000);
  const updatesBeforeResume = applied.length;

  for (let frame = 1; frame <= 120; frame += 1) {
    clock.tick(1000 + frame * (1000 / 120));
  }

  const resumedUpdates = applied.length - updatesBeforeResume;
  assert.ok(resumedUpdates <= 60, `Mol* received ${resumedUpdates} updates during one second after the stall`);
  assert.ok(clock.pending.size <= 1, 'only one animation callback remains scheduled');
  controller.dispose();
});

test('manual frame selection pauses, snaps to an exact sample, and clamps to the real frame range', () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  const controller = createController(clock, {
    frameCount: 207,
    applyIndex: (index, progress) => applied.push([index, progress]),
  });
  controller.play();
  controller.setIndex(900);
  assert.equal(controller.getIndex(), 206);
  assert.equal(controller.isPlaying(), false);
  assert.equal(controller.getTransition(), null);
  assert.equal(clock.pending.size, 0);
  controller.setIndex(100);
  controller.play();
  clock.tick(0);
  clock.tick(RAF_INTERVAL);
  assert.ok(controller.getTransition());
  controller.step(-1);
  assert.equal(controller.getIndex(), 99);
  assert.equal(controller.getTransition(), null);
  controller.reset();
  assert.equal(controller.getIndex(), 0);
  assert.deepEqual(applied.slice(-3), [[100, 1 / 15], [99, 0], [0, 0]]);
  controller.dispose();
});

test('single-conformer playback does not start and disposal cancels its pending animation frame', () => {
  const clock = fakeAnimationFrames();
  const single = createController(clock, { frameCount: 1 });
  single.play();
  assert.equal(single.isPlaying(), false);
  assert.equal(clock.pending.size, 0);

  const controller = createController(clock, { frameCount: 5 });
  controller.play();
  assert.equal(clock.pending.size, 1);
  controller.dispose();
  assert.equal(controller.isPlaying(), false);
  assert.equal(clock.pending.size, 0);
  assert.equal(clock.cancelled.length, 1);
});

test('asynchronous Mol* updates are serialized and only the latest manual selection is applied', async () => {
  const clock = fakeAnimationFrames();
  const applied = [];
  let activeUpdates = 0;
  let maxActiveUpdates = 0;
  let resolveCurrent;
  const controller = createController(clock, {
    frameCount: 8,
    applyIndex: (index, progress) => {
      applied.push([index, progress]);
      activeUpdates += 1;
      maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
      return new Promise((resolve) => {
        resolveCurrent = () => {
          activeUpdates -= 1;
          resolve();
        };
      });
    },
  });
  controller.setIndex(1);
  controller.setIndex(2);
  assert.deepEqual(applied, [[1, 0]]);
  resolveCurrent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [[1, 0], [2, 0]]);
  assert.equal(maxActiveUpdates, 1);
  resolveCurrent();
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
});

test('a pending frame task that rejects after unmount does not report state into the disposed view', async () => {
  let rejectUpdate;
  const errors = [];
  const clock = fakeAnimationFrames();
  const controller = createController(clock, {
    applyIndex: () => new Promise((resolve, reject) => { rejectUpdate = reject; }),
    onError: (error) => errors.push(error),
  });
  controller.setIndex(1);
  controller.dispose();
  rejectUpdate(new Error('viewer disposed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
});
