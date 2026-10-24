import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonCameraAction, comparisonChannelSignature } from './comparison-camera.js';

const composition = (...active) => ({ active });

test('detects channel selection, removal, order, and metric changes', () => {
  const fourChannels = composition(
    { id: 'conservation', tracks: [{ id: 'consurf_grade' }] },
    { id: 'topology', tracks: [{ id: 'tmbed_topology' }] },
    { id: 'ddg', tracks: [{ id: 'ddg_value' }] },
    { id: 'frustration', tracks: [{ id: 'frustratometer_mean' }] },
  );
  const withoutDdg = composition(fourChannels.active[0], fourChannels.active[1], fourChannels.active[3]);
  const reordered = composition(fourChannels.active[3], fourChannels.active[0], fourChannels.active[1], fourChannels.active[2]);
  const changedMetric = composition(
    fourChannels.active[0],
    fourChannels.active[1],
    fourChannels.active[2],
    { id: 'frustration', tracks: [{ id: 'frustraiseq_entropy' }] },
  );

  assert.notEqual(comparisonChannelSignature(fourChannels), comparisonChannelSignature(withoutDdg));
  assert.notEqual(comparisonChannelSignature(fourChannels), comparisonChannelSignature(reordered));
  assert.notEqual(comparisonChannelSignature(fourChannels), comparisonChannelSignature(changedMetric));
  assert.equal(comparisonChannelSignature(fourChannels), comparisonChannelSignature(composition(...fourChannels.active)));
});

test('reframes the full structure after channel changes without clearing a selected residue', () => {
  const previous = 'topology:tmbed_topology|ddg:ddg_value';
  const next = 'topology:tmbed_topology';

  assert.equal(comparisonCameraAction(previous, next), 'structure');
  assert.equal(comparisonCameraAction(previous, previous), 'none');
});
