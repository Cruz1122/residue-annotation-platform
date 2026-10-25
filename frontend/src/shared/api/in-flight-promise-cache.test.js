import assert from 'node:assert/strict';
import test from 'node:test';
import { createInFlightPromiseCache } from './in-flight-promise-cache.js';

test('shares concurrent work and removes a settled request', async () => {
  const cache = createInFlightPromiseCache();
  let loads = 0;
  let finish;
  const load = () => {
    loads += 1;
    return new Promise((resolve) => { finish = resolve; });
  };

  const first = cache.getOrCreate('same-request', load);
  const second = cache.getOrCreate('same-request', load);
  assert.equal(first, second);
  assert.equal(loads, 0);

  await Promise.resolve();
  assert.equal(loads, 1);
  finish('shared result');
  assert.equal(await first, 'shared result');
  assert.equal(await second, 'shared result');

  assert.equal(await cache.getOrCreate('same-request', async () => {
    loads += 1;
    return 'fresh result';
  }), 'fresh result');
  assert.equal(loads, 2);
});

test('removes failed requests so a later call can retry', async () => {
  const cache = createInFlightPromiseCache();
  let loads = 0;
  await assert.rejects(cache.getOrCreate('retry', () => {
    loads += 1;
    throw new Error('temporary failure');
  }), /temporary failure/);

  assert.equal(await cache.getOrCreate('retry', () => {
    loads += 1;
    return 'retried';
  }), 'retried');
  assert.equal(loads, 2);
});
