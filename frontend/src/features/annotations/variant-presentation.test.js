import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatVariantNumber,
  formatPublishedNumber,
  initialVariantSelection,
  indexVariantsByPosition,
  isScientistVisibleVariantArtifact,
  mergePublishedVariants,
  normalizeVariant,
  publishedDdg,
  replicateCount,
  variantDetailRows,
  variantKey,
  variantRecordFor,
} from './variant-presentation.js';

test('keeps only scientist-facing variant downloads in the artifact panel', () => {
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'variant_annotations' }), true);
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'provenance' }), true);
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'variant_dir' }), true);
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'annotations' }), false);
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'variant_set' }), false);
  assert.equal(isScientistVisibleVariantArtifact({ artifact_type: 'rosetta_metadata' }), false);
});

test('normalizes only concrete amino-acid substitutions with positive positions', () => {
  assert.deepEqual(normalizeVariant({ variant_id: 'f402l' }), {
    variant_id: 'f402l',
    aa_ref: 'F',
    aa_position: 402,
    aa_alt: 'L',
  });
  assert.equal(normalizeVariant({ variant_id: 'F0L' }), null);
  assert.equal(normalizeVariant({ variant_id: 'F402B' }), null);
  assert.equal(normalizeVariant({ variant_id: 'F402L', aa_position: 'not-a-number' }), null);
});

test('indexes the first published variant per residue for sequence-strip lookups', () => {
  const first = { aa_position: 12, variant_id: 'A12V' };
  const second = { aa_position: 12, variant_id: 'A12G' };
  const other = { aa_position: 20, variant_id: 'G20D' };
  const indexed = indexVariantsByPosition([first, second, other, { aa_position: 0 }]);
  assert.equal(indexed.size, 2);
  assert.strictEqual(indexed.get(12), first);
  assert.strictEqual(indexed.get(20), other);
  assert.equal(indexed.has(0), false);
});

test('merges requested and published variants without losing the published fields', () => {
  const variants = mergePublishedVariants(
    [{ variant_id: 'F402L', source: 'requested' }, { variant_id: 'R43C' }],
    [{ variant_id: 'F402L', ddg_value: '1.84', ddg_unit: 'REU' }],
  );

  assert.deepEqual(variants.map(variantKey), ['R43C', 'F402L']);
  assert.equal(variants[1].ddg_value, '1.84');
  assert.equal(variantRecordFor([{ variant_id: 'F402L', ddg_value: '1.84' }], 'F402L').ddg_value, '1.84');
});

test('starts with the first position-sorted variant while preserving explicit clears', () => {
  const variants = mergePublishedVariants([], [
    { variant_id: 'R43C' },
    { variant_id: 'E31K' },
  ]);
  assert.equal(variants[0].variant_id, 'E31K');
  assert.equal(variantKey(initialVariantSelection(variants, '', false)), 'E31K');
  assert.equal(variantKey(initialVariantSelection(variants, 'R43C', false)), 'R43C');
  assert.equal(initialVariantSelection(variants, '', true), null);
});

test('preserves the native ddg value and unit without inventing a conversion', () => {
  assert.deepEqual(publishedDdg({ ddg_value: '1.84', ddg_unit: 'REU' }), { value: 1.84, unit: 'REU' });
  assert.deepEqual(publishedDdg({ ddg_value: '-0.4' }, null, { units: { ddg_value: 'REU' } }), { value: -0.4, unit: 'REU' });
  assert.deepEqual(publishedDdg({ ddg_value: '1.84' }), { value: 1.84, unit: null });
  assert.equal(formatVariantNumber('not-a-number'), 'Sin dato publicado');
});

test('keeps development metadata out of the scientific detail rows', () => {
  assert.deepEqual(variantDetailRows({ ddg_value: 1.84 }, null, null), []);
  assert.deepEqual(variantDetailRows({
    ddg_value: 1.84,
    ddg_sd: '0.931334418992439',
    ddg_unit: 'REU',
    variant_classification: 'manual_variant',
    variant_source: 'manual_cli',
    ddg_engine: 'rosetta_scripts',
  }, null, null), [
    { label: 'Desviación estándar', value: 0.931334418992439, unit: 'REU' },
  ]);
});

test('formats published values without exposing floating point noise', () => {
  assert.equal(formatPublishedNumber('0.931334418992439'), '0.93');
  assert.equal(formatPublishedNumber('-0'), '0.00');
  assert.equal(formatPublishedNumber('1.84', { signed: true }), '+1.84');
});

test('counts only published replicate identifiers and prefers a published direct count', () => {
  const records = [
    { variant_id: 'F402L', replicate: 1, ddg_value: 1.1 },
    { variant_id: 'F402L', replicate: 2, ddg_value: 1.2 },
    { variant_id: 'R43C', replicate: 1, ddg_value: -0.2 },
  ];
  assert.equal(replicateCount(records, { variant_id: 'F402L' }), 2);
  assert.equal(replicateCount(records, { variant_id: 'F402L' }, { ddg_n_replicates: 5 }), 5);
  assert.equal(replicateCount(records, { variant_id: 'E21K' }), null);
});
