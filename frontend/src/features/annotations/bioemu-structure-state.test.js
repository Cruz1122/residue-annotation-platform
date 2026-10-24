import assert from 'node:assert/strict';
import test from 'node:test';
import { followBioEmuCameraTarget, updateBioEmuFrame } from './bioemu-structure-state.js';

test('a frame change reapplies the same residue selection without requesting a camera focus', async () => {
  const calls = [];
  let selectedPosition = 38;
  await updateBioEmuFrame({
    index: 42,
    commitModelIndex: async (index) => calls.push(['frame', index]),
    getSelectedPosition: () => selectedPosition,
    selectResidue: (position, options) => calls.push(['selection', position, options]),
  });
  assert.deepEqual(calls, [
    ['frame', 42],
    ['selection', 38, { focus: false }],
  ]);

  selectedPosition = 39;
  await updateBioEmuFrame({
    index: 43,
    commitModelIndex: async (index) => calls.push(['frame', index]),
    getSelectedPosition: () => selectedPosition,
    selectResidue: (position, options) => calls.push(['selection', position, options]),
  });
  assert.deepEqual(calls.slice(-2), [
    ['frame', 43],
    ['selection', 39, { focus: false }],
  ]);
});

test('frame changes do not select another residue when no residue is selected', async () => {
  const selected = [];
  let center = [1, 2, 3];
  const followedCenters = [];
  await updateBioEmuFrame({
    index: 0,
    commitModelIndex: async () => { center = [4, 5, 6]; },
    getSelectedPosition: () => null,
    selectResidue: (position) => selected.push(position),
    followCameraTarget: ({ selectedPosition }) => {
      assert.equal(selectedPosition, null);
      followedCenters.push([...center]);
    },
  });
  assert.deepEqual(selected, []);
  assert.deepEqual(followedCenters, [[4, 5, 6]], 'camera follows the structure after the new coordinates are committed');
});

test('a frame change follows the current selected-residue position after reapplying the selection', async () => {
  const calls = [];
  let residueCenter = [1, 2, 3];
  await updateBioEmuFrame({
    index: 12,
    commitModelIndex: async () => { residueCenter = [1.5, 2.5, 3.5]; },
    getSelectedPosition: () => 38,
    selectResidue: (position, options) => {
      calls.push(['selection', position, options]);
      return true;
    },
    followCameraTarget: ({ selectedPosition }) => calls.push(['camera', selectedPosition, [...residueCenter]]),
  });
  assert.deepEqual(calls, [
    ['selection', 38, { focus: false }],
    ['camera', 38, [1.5, 2.5, 3.5]],
  ]);
});

test('a frame update finishing after unmount does not touch the disposed selection', async () => {
  let active = true;
  const selected = [];
  await updateBioEmuFrame({
    index: 2,
    commitModelIndex: async () => { active = false; },
    getSelectedPosition: () => 4,
    selectResidue: (position) => selected.push(position),
    isActive: () => active,
  });
  assert.deepEqual(selected, []);
});

test('a residue that no longer maps to the PDB is surfaced instead of silently selecting another position', async () => {
  await assert.rejects(updateBioEmuFrame({
    index: 1,
    commitModelIndex: async () => undefined,
    getSelectedPosition: () => 38,
    selectResidue: () => false,
  }), /selección actual dejó de corresponder/);
});

test('camera focus follows the selected residue position while preserving the camera through translation', () => {
  const translations = [];
  const camera = { setTranslation: (target, duration) => translations.push({ target: [...target], duration }) };
  const lociApi = {
    is: (loci) => loci?.kind === 'loci',
    isEmpty: (loci) => loci.empty,
    getBoundingSphere: (loci) => ({ center: loci.center }),
  };

  assert.equal(followBioEmuCameraTarget({
    camera,
    structure: { boundary: { sphere: { center: [10, 10, 10] } } },
    selectedLoci: { kind: 'loci', center: [1, 2, 3] },
    lociApi,
    followSelection: true,
  }), true);
  assert.equal(followBioEmuCameraTarget({
    camera,
    structure: { boundary: { sphere: { center: [10, 10, 10] } } },
    selectedLoci: { kind: 'loci', center: [1.5, 2, 3] },
    lociApi,
    followSelection: true,
  }), true);

  assert.deepEqual(translations, [
    { target: [1, 2, 3], duration: 0 },
    { target: [1.5, 2, 3], duration: 0 },
  ]);
});

test('full-structure camera focus tracks its center and an invalid selected loci is reported', () => {
  const translations = [];
  const camera = { setTranslation: (target, duration) => translations.push({ target: [...target], duration }) };
  const lociApi = {
    is: (loci) => loci?.kind === 'loci',
    isEmpty: (loci) => loci.empty,
    getBoundingSphere: (loci) => ({ center: loci.center }),
  };

  assert.equal(followBioEmuCameraTarget({
    camera,
    structure: { boundary: { sphere: { center: [4, 5, 6] } } },
    lociApi,
    followSelection: false,
  }), true);
  assert.equal(followBioEmuCameraTarget({
    camera,
    structure: { boundary: { sphere: { center: [Number.NaN, 0, 0] } } },
    selectedLoci: { kind: 'loci', empty: true },
    lociApi,
    followSelection: true,
  }), false);
  assert.deepEqual(translations, [{ target: [4, 5, 6], duration: 0 }]);
});
