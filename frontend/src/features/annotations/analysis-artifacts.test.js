import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  firstDetailValue,
  functionalFeatureClass,
  loadAnalysisArtifactDetails,
  parseAnalysisArtifact,
  presentationRowsFromArtifacts,
  recordsForPosition,
  summarizeArtifactRecord,
} from './analysis-artifacts.js';

test('parses TSV detail artifacts without treating missing values as numbers', () => {
  const rows = parseAnalysisArtifact('aa_position\taa_ref\tddg_value\n12\tG\t1.25\n13\tL\tNA\n', 'text/tab-separated-values');
  assert.deepEqual(rows, [
    { aa_position: '12', aa_ref: 'G', ddg_value: '1.25' },
    { aa_position: '13', aa_ref: 'L', ddg_value: 'NA' },
  ]);
  assert.equal(firstDetailValue(rows[1], ['ddg_value']), null);
});

test('reads common JSON result envelopes and locates canonical positions', () => {
  const details = {
    evolution_per_residue: parseAnalysisArtifact(JSON.stringify({ rows: [{ aa_position: 7, reliable: true }] }), 'application/json'),
  };
  assert.deepEqual(recordsForPosition(details, 'evolution_per_residue', 7), [{ aa_position: 7, reliable: true }]);
});

test('projects numeric ddg values by canonical position with native row units', () => {
  const rows = presentationRowsFromArtifacts({
    variant_annotations: [{ variant_id: 'F402L', ddg_value: '1.84', ddg_unit: 'kcal/mol' }],
  }, 'ddg');
  assert.deepEqual(rows, [{
    aa_position: 402,
    aa_ref: 'F',
    stage_id: 'variant_ddg_artifact',
    values: { ddg_value: 1.84 },
    units: { ddg_value: 'kcal/mol' },
  }]);
});

test('resolves ddg units from provenance without inventing a default', () => {
  const withProvenance = presentationRowsFromArtifacts({
    variant_annotations: [{ aa_position: 8, aa_ref: 'R', ddg_value: -0.4 }],
    provenance: [{ units: { ddg_value: 'REU' } }],
  }, 'ddg');
  assert.deepEqual(withProvenance[0].units, { ddg_value: 'REU' });

  const withoutUnit = presentationRowsFromArtifacts({
    variant_annotations: [{ aa_position: 8, aa_ref: 'R', ddg_value: -0.4 }],
  }, 'ddg');
  assert.deepEqual(withoutUnit[0].units, {});
});

test('projects real UniProt feature rows into meaningful functional classes', () => {
  assert.equal(functionalFeatureClass({ feature_type: 'Signal' }), 'highlighted_segment');
  assert.equal(functionalFeatureClass({ feature_type: 'Binding site' }), 'functional_interest');
  assert.equal(functionalFeatureClass({ feature_type: 'Region' }), 'curated_region');

  const rows = presentationRowsFromArtifacts({
    functional_features_long: [
      { aa_position: 1, aa_ref: 'M', feature_type: 'Signal', feature_name: 'Signal', mapping_status: 'exact' },
      { aa_position: 2, aa_ref: 'K', feature_type: 'Binding site', feature_name: 'LDL binding', mapping_status: 'exact' },
      { aa_position: 2, aa_ref: 'K', feature_type: 'Region', feature_name: 'Ligand region', mapping_status: 'exact' },
    ],
  }, 'functional');
  assert.deepEqual(rows, [
    {
      aa_position: 1,
      aa_ref: 'M',
      stage_id: 'uniprot_features_artifact',
      values: {
        functional_feature_class: 'highlighted_segment',
        functional_feature_type: 'Signal',
        functional_feature_name: 'Signal',
        functional_feature_mapping_status: 'exact',
      },
      units: {},
    },
    {
      aa_position: 2,
      aa_ref: 'K',
      stage_id: 'uniprot_features_artifact',
      values: {
        functional_feature_class: 'curated_region|functional_interest',
        functional_feature_type: 'Binding site · Region',
        functional_feature_name: 'LDL binding · Ligand region',
        functional_feature_mapping_status: 'exact',
      },
      units: {},
    },
  ]);
});

test('normalizes a functional summary into bounded readable text', () => {
  assert.equal(summarizeArtifactRecord({ summary: '2 regiones curatoriales' }), '2 regiones curatoriales');
  assert.equal(summarizeArtifactRecord({ matched: 2, total: 4, nested: { ignored: true }, extra: 'ok' }), 'matched: 2 · total: 4 · extra: ok');
  assert.equal(summarizeArtifactRecord({ summary: 'x'.repeat(500) }).length, 318);
});

test('skips oversized and failed detail artifacts without losing valid artifacts', async () => {
  const requested = [];
  const run = {
    stages: [{
      artifacts: [
        { id: 'valid', artifact_type: 'evolution_per_residue', size: 128, media_type: 'application/json' },
        { id: 'failed', artifact_type: 'metadata', size: 128, media_type: 'application/json' },
        { id: 'oversized', artifact_type: 'metadata', size: 3 * 1024 * 1024, media_type: 'application/json' },
      ],
    }],
  };
  const details = await loadAnalysisArtifactDetails(run, 'conservation', async (id) => {
    requested.push(id);
    if (id === 'failed') throw new Error('unavailable');
    return { text: async () => '{"rows":[{"aa_position":7,"reliable":true}]}' };
  });
  assert.deepEqual(requested.sort(), ['failed', 'valid']);
  assert.deepEqual(details, { evolution_per_residue: [{ aa_position: 7, reliable: true }] });
});

test('loads conformational ensemble metadata under a stage-specific key', async () => {
  const requested = [];
  const run = {
    stages: [{
      id: 'conformational_ensemble',
      artifacts: [
        { id: 'metadata', artifact_type: 'metadata', size: 128, media_type: 'application/json' },
        { id: 'frames', artifact_type: 'frames_index', size: 128, media_type: 'text/tab-separated-values' },
      ],
    }],
  };
  const details = await loadAnalysisArtifactDetails(run, 'frustration', async (id) => {
    requested.push(id);
    if (id === 'metadata') return { text: async () => '{"ensemble_size":207,"model":"bioemu-v1.2"}' };
    return { text: async () => 'table_row\tround\txtc_frame\n0\t0\t0\n' };
  });

  assert.deepEqual(requested.sort(), ['frames', 'metadata']);
  assert.equal(details.conformational_ensemble_metadata[0].ensemble_size, 207);
  assert.equal(details.conformational_ensemble_frames_index.length, 1);
});

test('decompresses gzip detail artifacts before parsing', async () => {
  const tsv = 'aa_position_1\taa_position_2\tinteraction_type\tdistance_A\n79\t127\tpolar\t3.1\n';
  const compressed = gzipSync(tsv);
  const run = {
    stages: [{
      id: 'structural_contacts',
      artifacts: [{
        id: 'long',
        artifact_type: 'contacts_long',
        size: compressed.length,
        media_type: 'application/gzip',
        download_filename: 'contacts_long.tsv.gz',
      }],
    }],
  };
  const details = await loadAnalysisArtifactDetails(run, 'contacts', async () => new Blob([compressed], { type: 'application/gzip' }));
  assert.equal(details.contacts_long.length, 1);
  assert.equal(details.contacts_long[0].aa_position_2, '127');
});

test('loads only structural_contacts provenance for the contacts analysis', async () => {
  const requested = [];
  const run = {
    stages: [
      {
        id: 'structural_frustration',
        artifacts: [{ id: 'wrong-provenance', artifact_type: 'provenance', size: 64, media_type: 'application/json' }],
      },
      {
        id: 'structural_contacts',
        artifacts: [{ id: 'right-provenance', artifact_type: 'provenance', size: 64, media_type: 'application/json' }],
      },
    ],
  };
  const details = await loadAnalysisArtifactDetails(run, 'contacts', async (id) => {
    requested.push(id);
    return {
      text: async () => (id === 'right-provenance'
        ? '{"parameters":{"interacting_A":5,"ph":7.4}}'
        : '{"parameters":{"interacting_A":4.5,"ph":6.5}}'),
    };
  });
  assert.deepEqual(requested, ['right-provenance']);
  assert.equal(details.provenance[0].parameters.interacting_A, 5);
});

test('keeps the summary when gzip detail is unreadable', async () => {
  const run = {
    stages: [{
      id: 'structural_contacts',
      artifacts: [
        { id: 'summary', artifact_type: 'contact_residue_summary', size: 128, media_type: 'text/tab-separated-values' },
        { id: 'broken', artifact_type: 'contacts_long', size: 64, media_type: 'application/gzip' },
      ],
    }],
  };
  const details = await loadAnalysisArtifactDetails(run, 'contacts', async (id) => {
    if (id === 'broken') return new Blob([new Uint8Array([1, 2, 3])], { type: 'application/gzip' });
    return { text: async () => 'aa_position\tstructural_contacts_n_contacts\n79\t11\n' };
  });
  assert.equal(details.contact_residue_summary.length, 1);
  assert.equal(details.contact_residue_summary[0].structural_contacts_n_contacts, '11');
  assert.equal(details.contacts_long, undefined);
});

test('aborts oversized decompressed detail and keeps the summary', async () => {
  const huge = 'x'.repeat(33 * 1024 * 1024);
  const compressed = gzipSync(huge);
  const run = {
    stages: [{
      id: 'structural_contacts',
      artifacts: [
        { id: 'summary', artifact_type: 'contact_residue_summary', size: 128, media_type: 'text/tab-separated-values' },
        { id: 'huge', artifact_type: 'contacts_long', size: compressed.length, media_type: 'application/gzip' },
      ],
    }],
  };
  const details = await loadAnalysisArtifactDetails(run, 'contacts', async (id) => {
    if (id === 'huge') return new Blob([compressed], { type: 'application/gzip' });
    return { text: async () => 'aa_position\tstructural_contacts_n_contacts\n79\t11\n' };
  });
  assert.equal(details.contact_residue_summary.length, 1);
  assert.equal(details.contacts_long, undefined);
});
