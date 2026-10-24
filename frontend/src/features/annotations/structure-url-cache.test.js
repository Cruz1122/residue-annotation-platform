import assert from 'node:assert/strict';
import test from 'node:test';
import { createStructureUrlCache } from './structure-url-cache.js';

test('shares an in-flight structure load and keeps the URL after release', async () => {
  let loads = 0;
  const revoked = [];
  const cache = createStructureUrlCache({
    ttlMs: Number.POSITIVE_INFINITY,
    revoke: (url) => revoked.push(url),
  });
  const first = cache.acquire('reference', async () => {
    loads += 1;
    return 'blob:reference';
  });
  const second = cache.acquire('reference', async () => {
    loads += 1;
    return 'blob:unexpected';
  });

  assert.equal(await first.promise, 'blob:reference');
  assert.equal(await second.promise, 'blob:reference');
  assert.equal(loads, 1);
  first.release();
  second.release();
  assert.deepEqual(cache.snapshot(), [{ key: 'reference', url: 'blob:reference', refs: 0, pending: false }]);
  assert.deepEqual(revoked, []);
});

test('evicts the least recently used released URL at the bounded limit', async () => {
  const revoked = [];
  const cache = createStructureUrlCache({
    maxEntries: 2,
    ttlMs: Number.POSITIVE_INFINITY,
    revoke: (url) => revoked.push(url),
  });
  const first = cache.acquire('one', () => 'blob:one');
  assert.equal(await first.promise, 'blob:one');
  first.release();
  const second = cache.acquire('two', () => 'blob:two');
  assert.equal(await second.promise, 'blob:two');
  second.release();
  const third = cache.acquire('three', () => 'blob:three');
  assert.equal(await third.promise, 'blob:three');

  assert.deepEqual(revoked, ['blob:one']);
  assert.deepEqual(cache.snapshot().map((entry) => entry.key), ['two', 'three']);
  third.release();
  cache.clear();
  assert.deepEqual(revoked, ['blob:one', 'blob:two', 'blob:three']);
});
