import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignCanonicalPositions,
  colorForValues,
  colorOnScale,
  normalizeValue,
  relativeDomain,
  residueDisplayColor,
  VISUALIZATION_MODES,
} from './viewer-presentation.js';

test('NA is not a number and is not treated as zero', () => {
  assert.equal(normalizeValue('NA', 0, 10), null);
  assert.equal(normalizeValue(null, 0, 10), null);
  assert.equal(normalizeValue('', 0, 10), null);
  assert.equal(normalizeValue(0, 0, 10), 0);
});

test('continuous color uses the visual midpoint, not a neighbor blend', () => {
  const colors = VISUALIZATION_MODES.frustration.colors;
  assert.equal(colorOnScale(0, colors), colors[0]);
  assert.equal(colorOnScale(0.5, colors), colors[1]);
  assert.equal(colorOnScale(1, colors), colors[2]);
  assert.equal(colorOnScale(null, colors), null);
});

test('rate4site keeps the more negative end on the low color', () => {
  const domain = { min: -2, max: 2 };
  const low = colorForValues('conservation', { rate4site_score: -2 }, domain);
  const high = colorForValues('conservation', { rate4site_score: 2 }, domain);
  assert.equal(low, VISUALIZATION_MODES.conservation.colors[0]);
  assert.equal(high, VISUALIZATION_MODES.conservation.colors[2]);
  assert.equal(colorForValues('conservation', { rate4site_score: 'NA' }, domain), null);
});

test('regime stays categorical', () => {
  assert.equal(colorForValues('regime', { structural_regime: 'membrane' }, null), '#269b65');
  assert.equal(colorForValues('regime', { structural_regime: 'NA' }, null), null);
  assert.equal(residueDisplayColor('regime', {}, null, null), '#b8bec5');
});

test('relative domain ignores missing values', () => {
  const domain = relativeDomain('contacts', [
    { values: { structural_contacts_n_contacts: 'NA' } },
    { values: { structural_contacts_n_contacts: 2 } },
    { values: { structural_contacts_n_contacts: 8 } },
  ]);
  assert.deepEqual(domain, { min: 2, max: 8, relative: true });
});

test('canonical position follows sequence identity, not PDB numbering', () => {
  const chains = assignCanonicalPositions([
    {
      id: 'A',
      residues: [
        { chain: 'A', authSeqId: 50, insCode: '', one: 'M' },
        { chain: 'A', authSeqId: 51, insCode: '', one: 'A' },
      ],
    },
  ], 'MA');
  assert.deepEqual(chains[0].residues.map((residue) => residue.aaPosition), [1, 2]);

  const mismatched = assignCanonicalPositions([
    { id: 'A', residues: [{ chain: 'A', authSeqId: 1, insCode: '', one: 'M' }] },
  ], 'MA');
  assert.equal(mismatched[0].residues[0].aaPosition, null);
});
