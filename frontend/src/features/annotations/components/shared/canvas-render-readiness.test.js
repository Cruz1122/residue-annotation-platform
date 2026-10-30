import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCanvasDraw } from './canvas-render-readiness.js';

class Subject {
  value;
  observers = new Set();

  constructor(value) {
    this.value = value;
  }

  subscribe(observer) {
    this.observers.add(observer);
    observer(this.value);
    return { unsubscribe: () => this.observers.delete(observer) };
  }

  next(value) {
    this.value = value;
    for (const observer of this.observers) observer(value);
  }
}

function canvasFixture() {
  return {
    didDraw: new Subject(0),
    commitQueueSize: new Subject(0),
    boundingSphereVisible: { radius: 0 },
    drawRequests: 0,
    requestDraw() { this.drawRequests += 1; },
  };
}

test('waits for a new draw and a committed molecular structure', async () => {
  const canvas = canvasFixture();
  let settled = false;
  const waiting = waitForCanvasDraw(canvas, { timeoutMs: 1000 }).then(() => { settled = true; });

  assert.equal(canvas.drawRequests, 1);
  canvas.boundingSphereVisible.radius = 12;
  canvas.didDraw.next(1);
  await waiting;
  assert.equal(settled, true);
});

test('accepts an already drawn and committed structure without requiring another frame', async () => {
  const canvas = canvasFixture();
  canvas.didDraw.value = 12;
  canvas.boundingSphereVisible.radius = 8;

  await waitForCanvasDraw(canvas, { timeoutMs: 25 });
  assert.equal(canvas.drawRequests, 1);
});

test('waits for a draw after a Mol* representation change when requested', async () => {
  const canvas = canvasFixture();
  canvas.didDraw.value = 12;
  canvas.boundingSphereVisible.radius = 8;
  let settled = false;
  const waiting = waitForCanvasDraw(canvas, { timeoutMs: 1000, requireNewDraw: true })
    .then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  canvas.didDraw.next(13);
  await waiting;
  assert.equal(settled, true);
});

test('accepts a draw that arrived after the load baseline but before the wait was installed', async () => {
  const canvas = canvasFixture();
  canvas.didDraw.value = 12;
  canvas.boundingSphereVisible.radius = 8;
  const drawBaseline = canvas.didDraw.value;

  // The replacement CIF may draw while its load task is still completing.
  canvas.didDraw.next(13);

  await waitForCanvasDraw(canvas, { timeoutMs: 25, drawBaseline });
  assert.equal(canvas.didDraw.observers.size, 0);
});

test('does not treat a pre-load draw as evidence that the replacement structure rendered', async () => {
  const canvas = canvasFixture();
  canvas.didDraw.value = 12;
  const drawBaseline = canvas.didDraw.value;
  let settled = false;
  const waiting = waitForCanvasDraw(canvas, { timeoutMs: 1000, drawBaseline })
    .then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  canvas.didDraw.next(13);
  await Promise.resolve();
  assert.equal(settled, false);
  canvas.boundingSphereVisible.radius = 8;
  canvas.commitQueueSize.next(0);
  await Promise.resolve();
  assert.equal(settled, false);
  canvas.didDraw.next(14);
  await waiting;
  assert.equal(settled, true);
});

test('does not report ready when Mol* draws before the structure is committed', async () => {
  const canvas = canvasFixture();
  let settled = false;
  const waiting = waitForCanvasDraw(canvas, { timeoutMs: 1000 }).then(() => { settled = true; });

  canvas.boundingSphereVisible.radius = 12;
  canvas.commitQueueSize.next(1);
  canvas.didDraw.next(1);
  assert.equal(settled, false);
  canvas.commitQueueSize.next(0);
  await waiting;
  assert.equal(settled, true);
});

test('cleans up promptly when the viewer is disposed', async () => {
  const canvas = canvasFixture();
  const controller = new AbortController();
  const waiting = waitForCanvasDraw(canvas, { signal: controller.signal, timeoutMs: 1000 });

  controller.abort();
  await waiting;
  assert.equal(canvas.didDraw.observers.size, 0);
  assert.equal(canvas.commitQueueSize.observers.size, 0);
});
