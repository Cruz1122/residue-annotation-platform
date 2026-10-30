import assert from 'node:assert/strict';
import test from 'node:test';
import {
  frustrationStructureResidueGroups,
  frustrationStructureSelection,
  frustrationPositionMap,
  frustrationRecordsAtPosition,
  indexFrustrationArtifactDetails,
  remapFrustrationAnnotations,
  remapFrustrationArtifactDetails,
  remapFrustrationStructureMaps,
} from './frustration-artifact-index.js';

test('indexes published artifact rows by canonical residue without changing source order', () => {
  const first = { aa_position: '2', frustraiseq_index: '-1.2' };
  const second = { position: 2, frustraiseq_class: 'highly_frustrated' };
  const details = indexFrustrationArtifactDetails({
    frustraiseq_per_residue: [first, { aa_position: 'NA' }, second],
    frustration_per_residue: [{ residue_number: 2, value: '0.4' }],
    ignored_artifact: [{ aa_position: 2, value: 'not indexed' }],
  });

  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustraiseq_per_residue', 2), [first, second]);
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustration_per_residue', 2), [{ residue_number: 2, value: '0.4' }]);
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustraiseq_per_residue', 99), []);
  assert.equal(details.has('ignored_artifact'), false);
});

test('ignores malformed records and accepts only positive integer positions', () => {
  const details = indexFrustrationArtifactDetails({
    frustratometer_per_residue: [
      null,
      { aa_position: 0 },
      { aa_position: -1 },
      { aa_position: 1.2 },
      { aa_position: '3', value: 2 },
    ],
  });
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustratometer_per_residue', 3), [{ aa_position: '3', value: 2 }]);
  assert.equal(details.get('frustratometer_per_residue').size, 1);
});

test('maps precursor artifact positions onto a unique mature-sequence fragment', () => {
  const referenceRows = [
    { aa_position: 1, aa_ref: 'M' },
    { aa_position: 2, aa_ref: 'K' },
    { aa_position: 3, aa_ref: 'A' },
    { aa_position: 4, aa_ref: 'Q' },
    { aa_position: 5, aa_ref: 'E' },
    { aa_position: 6, aa_ref: 'D' },
  ];
  const positions = frustrationPositionMap('QED', referenceRows);

  assert.deepEqual([...positions], [[4, 1], [5, 2], [6, 3]]);
});

test('rebases frustration values and structure coordinates together', () => {
  const targetSequence = 'QED';
  const sourceRows = [
    { aa_position: 1, aa_ref: 'M', frustraiseq_index: 0.1 },
    { aa_position: 2, aa_ref: 'K', frustraiseq_index: 0.2 },
    { aa_position: 3, aa_ref: 'A', frustraiseq_index: 0.3 },
    { aa_position: 4, aa_ref: 'Q', frustraiseq_index: -1.1 },
    { aa_position: 5, aa_ref: 'E', frustraiseq_index: 0.2 },
    { aa_position: 6, aa_ref: 'D', frustraiseq_index: 1.2 },
  ];
  const positionMap = frustrationPositionMap(targetSequence, sourceRows);
  const details = remapFrustrationArtifactDetails({ frustraiseq_per_residue: sourceRows }, targetSequence);
  const mappedStructure = remapFrustrationStructureMaps({
    byCanonical: new Map([[1, 'A|1|'], [4, 'A|4|'], [5, 'A|5|'], [6, 'A|6|']]),
    byStructure: new Map([['A|1|', 1], ['A|4|', 4], ['A|5|', 5], ['A|6|', 6]]),
  }, positionMap);

  assert.deepEqual(details.frustraiseq_per_residue.map((row) => [row.aa_position, row.source_aa_position]), [
    [1, 4], [2, 5], [3, 6],
  ]);
  assert.deepEqual([...mappedStructure.byCanonical], [[1, 'A|4|'], [2, 'A|5|'], [3, 'A|6|']]);
  assert.deepEqual([...mappedStructure.byStructure], [['A|4|', 1], ['A|5|', 2], ['A|6|', 3]]);
});

test('keeps run-relative annotations and projects source rows only when the residue agrees', () => {
  const positions = new Map([[4, 1], [5, 2], [6, 3]]);
  const remapped = remapFrustrationAnnotations([
    { aa_position: 1, aa_ref: 'Q', values: { local: true } },
    { aa_position: 4, aa_ref: 'Q', values: { source: true } },
    { aa_position: 4, aa_ref: 'M', values: { wrong: true } },
  ], 'QED', positions);

  assert.deepEqual(remapped.map((row) => [row.aa_position, row.aa_ref, row.values]), [
    [1, 'Q', { local: true }],
    [1, 'Q', { source: true }],
  ]);
});

test('does not guess when a source residue sequence matches in multiple locations', () => {
  const positions = frustrationPositionMap('AAA', [
    { aa_position: 1, aa_ref: 'M' },
    { aa_position: 2, aa_ref: 'A' },
    { aa_position: 3, aa_ref: 'A' },
    { aa_position: 4, aa_ref: 'A' },
    { aa_position: 5, aa_ref: 'A' },
  ]);

  assert.deepEqual([...positions], []);
});

test('groups mapped structure residues for a focused Mol* selection', () => {
  const groups = frustrationStructureResidueGroups(new Map([
    ['A|31|', 1],
    ['A|32|', 2],
    ['A|33|A', 3],
    ['B|8|', 4],
    ['A|not-a-number|', 5],
  ]));

  assert.deepEqual(groups, [
    { chain: 'A', insertionCode: '', residueNumbers: [31, 32] },
    { chain: 'A', insertionCode: 'A', residueNumbers: [33] },
    { chain: 'B', insertionCode: '', residueNumbers: [8] },
  ]);
});

test('creates a stable Mol* selection signature only when mapped coverage reaches half the run', () => {
  const first = frustrationStructureSelection(new Map([
    ['B|8|', 4],
    ['A|32|', 2],
    ['A|31|', 1],
    ['invalid|x|', 5],
  ]), 4);
  const reordered = frustrationStructureSelection(new Map([
    ['A|31|', 1],
    ['A|32|', 2],
    ['B|8|', 4],
  ]), 4);
  const insufficient = frustrationStructureSelection(new Map([
    ['A|31|', 1],
    ['invalid|x|', 2],
  ]), 4);

  assert.equal(first.coverage, 0.75);
  assert.deepEqual(first.groups, [
    { chain: 'A', insertionCode: '', residueNumbers: [31, 32] },
    { chain: 'B', insertionCode: '', residueNumbers: [8] },
  ]);
  assert.equal(first.signature, reordered.signature);
  assert.equal(insufficient.coverage, 0.25);
  assert.deepEqual(insufficient, { groups: [], signature: '', coverage: 0.25 });
});
