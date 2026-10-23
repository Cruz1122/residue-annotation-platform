import test from 'node:test';
import assert from 'node:assert/strict';

import {
  membraneStatus,
  normalizeTopologyClass,
  structureSelectionItems,
  topologyClassProbability,
  topologyCounts,
  topologyRegions,
} from './topology-presentation.js';

test('normalizes only published TMbed topology classes', () => {
  assert.equal(normalizeTopologyClass('tm-alpha'), 'tm_alpha');
  assert.equal(normalizeTopologyClass('signal peptide'), 'signal_peptide');
  assert.equal(normalizeTopologyClass('unexpected'), 'unknown');
});

test('reads the probability that corresponds to the selected class', () => {
  const row = { p_tm_alpha: '0.82', p_outside: '0.12' };
  assert.equal(topologyClassProbability(row, 'tm_alpha'), 0.82);
  assert.equal(topologyClassProbability(row, 'outside'), 0.12);
  assert.equal(topologyClassProbability(row, 'unknown'), null);
});

test('groups contiguous regions without joining separated runs', () => {
  const rows = [
    { position: 1, topologyClass: 'signal_peptide' },
    { position: 2, topologyClass: 'signal_peptide' },
    { position: 3, topologyClass: 'outside' },
    { position: 5, topologyClass: 'outside' },
  ];
  assert.deepEqual(topologyRegions(rows), [
    { topologyClass: 'signal_peptide', start: 1, end: 2, count: 2 },
    { topologyClass: 'outside', start: 3, end: 3, count: 1 },
    { topologyClass: 'outside', start: 5, end: 5, count: 1 },
  ]);
  assert.deepEqual([...topologyCounts(rows)], [['signal_peptide', 2], ['outside', 2]]);
});

test('maps a selected topology region to every mapped structure residue', () => {
  const structureByCanonical = new Map([
    [10, 'A|110|'],
    [11, 'A|111|A'],
    [12, 'B|5|'],
    [13, 'A|113|'],
  ]);
  assert.deepEqual(structureSelectionItems(structureByCanonical, 10, 12), [
    { auth_asym_id: 'A', auth_seq_id: 110 },
    { auth_asym_id: 'A', auth_seq_id: 111, pdbx_PDB_ins_code: 'A' },
    { auth_asym_id: 'B', auth_seq_id: 5 },
  ]);
  assert.deepEqual(structureSelectionItems(structureByCanonical, 12, 11), []);
  assert.deepEqual(structureSelectionItems(structureByCanonical, 10, 99), [
    { auth_asym_id: 'A', auth_seq_id: 110 },
    { auth_asym_id: 'A', auth_seq_id: 111, pdbx_PDB_ins_code: 'A' },
    { auth_asym_id: 'B', auth_seq_id: 5 },
    { auth_asym_id: 'A', auth_seq_id: 113 },
  ]);
});

test('does not claim an orientation when TMbed found no TM segment', () => {
  assert.deepEqual(membraneStatus({ orientation: 'NA', reason: 'TMbed produced no transmembrane segments.' }, 0), {
    label: 'No aplica',
    reason: 'TMbed produced no transmembrane segments.',
    orientation: null,
  });
});
