import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baseProteinStructureRuns,
  groupRunsByBaseProtein,
  isHiddenExternalRunSequenceProtein,
  proteinDisplayName,
  proteinProgressHref,
  proteinSearchValues,
  preferredStructureArtifact,
  runStructureArtifacts,
  runActivityText,
  runDurationText,
  runStatusLabel,
} from './protein-display.js';

test('prefers a published gene alias for the protein display name', () => {
  const protein = {
    id: 'protein-uuid',
    aliases: [
      { source: 'fasta_header', identifier: 'sp|P02649|APOE_HUMAN' },
      { source: 'gene', identifier: 'APOE' },
    ],
  };

  assert.equal(proteinDisplayName(protein), 'APOE');
  assert.ok(proteinSearchValues(protein).includes('protein-uuid'));
  assert.ok(proteinSearchValues(protein).includes('APOE_HUMAN'));
});

test('uses the canonical gene for a known accession in a FASTA header', () => {
  assert.equal(
    proteinDisplayName({ aliases: [{ source: 'fasta_header', identifier: 'sp|P02649|APOE_HUMAN' }] }),
    'APOE',
  );
});

test('uses the accession identity when a shared gene alias conflicts', () => {
  assert.equal(
    proteinDisplayName({
      aliases: [
        { source: 'uniprot', identifier: 'P01130' },
        { source: 'gene', identifier: 'EGFR' },
      ],
    }),
    'LDLR',
  );
});

test('includes the selected run when opening a protein analysis', () => {
  const protein = { id: 'protein/uuid' };
  const run = { id: 'run/uuid' };

  assert.equal(
    proteinProgressHref(protein, run),
    '/proteins/protein%2Fuuid/progress/?run=run%2Fuuid',
  );
  assert.equal(
    proteinProgressHref(protein),
    '/proteins/protein%2Fuuid/progress/',
  );
});

test('shows a live run duration without confusing it with structure availability', () => {
  const run = {
    status: 'running',
    started_at: '2026-10-19T12:00:00.000Z',
    finished_at: null,
  };

  assert.equal(runStatusLabel(run.status), 'En ejecución');
  assert.equal(runDurationText(run, Date.parse('2026-10-19T12:03:05.000Z')), 'Lleva 3 min 5 s');
  assert.equal(runActivityText(run, Date.parse('2026-10-19T12:03:05.000Z')), 'En ejecución · Lleva 3 min 5 s');
});

test('shows terminal status and recorded duration for cancelled runs', () => {
  const run = {
    status: 'cancelled',
    started_at: '2026-10-19T12:00:00.000Z',
    finished_at: '2026-10-19T12:01:12.000Z',
  };

  assert.equal(runActivityText(run), 'Cancelada · Duró 1 min 12 s');
  assert.equal(runActivityText(null), 'Sin corridas');
});

test('does not present locally generated timestamps as remote execution duration', () => {
  const importedRun = {
    status: 'success',
    is_external_import: true,
    external_tracking: { source: 'mn5', tracking_active: false },
    started_at: '2026-10-19T12:00:00.000Z',
    finished_at: '2026-10-19T12:00:00.000Z',
  };

  assert.equal(runDurationText(importedRun), '');
  assert.equal(runActivityText(importedRun), 'Completada');
});

test('groups external mutant and DDG runs under the base protein', () => {
  const runs = [
    {
      id: 'ddg-run',
      protein_id: 'base-protein',
      external_tracking: { run_type: 'ddg', base_protein_id: 'base-protein' },
    },
    {
      id: 'mutant-run',
      protein_id: 'mutated-sequence',
      external_tracking: { run_type: 'mutant', base_protein_id: 'base-protein' },
    },
  ];
  const groups = groupRunsByBaseProtein(runs);

  assert.deepEqual(groups.get('base-protein').map((run) => run.id), ['ddg-run', 'mutant-run']);
  assert.equal(isHiddenExternalRunSequenceProtein('mutated-sequence', runs), true);
  assert.equal(isHiddenExternalRunSequenceProtein('base-protein', runs), false);
});

test('uses published structures from incomplete runs and prefers a relaxed PDB', () => {
  const run = {
    status: 'running',
    stages: [
      { artifacts: [{ id: 'reference', artifact_type: 'selected_reference_pdb', download_filename: 'reference.pdb' }] },
      { artifacts: [{ id: 'relaxed', artifact_type: 'foldx_relaxed_pdb', download_filename: 'relaxed.pdb' }] },
    ],
  };

  assert.equal(runStructureArtifacts(run).length, 2);
  assert.equal(preferredStructureArtifact(run).id, 'relaxed');
});

test('selects only base-sequence structures for the protein library preview', () => {
  const artifact = { artifact_type: 'model_cif' };
  const runs = [
    { id: 'mutant', external_tracking: { run_type: 'mutant' }, stages: [{ artifacts: [artifact] }] },
    { id: 'ddg', external_tracking: { run_type: 'ddg' }, stages: [{ artifacts: [artifact] }] },
    { id: 'base', external_tracking: { run_type: 'base' }, stages: [{ artifacts: [artifact] }] },
    { id: 'local', stages: [{ artifacts: [artifact] }] },
    { id: 'without-structure', external_tracking: { run_type: 'ddg' }, stages: [] },
  ];

  assert.deepEqual(baseProteinStructureRuns(runs).map((run) => run.id), ['ddg', 'base', 'local']);
});

test('hides an external base query sequence while retaining its grouped base protein', () => {
  const runs = [
    {
      id: 'ugt-base-run',
      protein_id: 'ugt-structure-query',
      external_tracking: { run_type: 'base', base_protein_id: 'ugt-canonical-base' },
    },
  ];

  assert.equal(isHiddenExternalRunSequenceProtein('ugt-structure-query', runs), true);
  assert.equal(isHiddenExternalRunSequenceProtein('ugt-canonical-base', runs), false);
  assert.equal(
    isHiddenExternalRunSequenceProtein('ugt-structure-query', [
      ...runs,
      { id: 'independent-run', protein_id: 'ugt-structure-query' },
    ]),
    false,
  );
});
