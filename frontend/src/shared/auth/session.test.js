import assert from 'node:assert/strict';
import test from 'node:test';
import { safeInternalPath } from './session.ts';

test('uses the proteins catalog as the post-login destination for the onboarding root', () => {
  assert.equal(safeInternalPath('/'), '/proteins/');
  assert.equal(safeInternalPath('/?source=login'), '/proteins/');
});

test('preserves valid internal destinations', () => {
  assert.equal(safeInternalPath('/proteins/?filter=human#recent'), '/proteins/?filter=human#recent');
});

test('falls back for external and protocol-relative destinations', () => {
  assert.equal(safeInternalPath('https://example.com'), '/proteins/');
  assert.equal(safeInternalPath('//example.com'), '/proteins/');
});
