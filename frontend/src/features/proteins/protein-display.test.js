import assert from 'node:assert/strict';
import test from 'node:test';

import {
  proteinDisplayName,
  proteinProgressHref,
  proteinSearchValues,
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

test('cleans a FASTA/UniProt header when no gene alias exists', () => {
  assert.equal(
    proteinDisplayName({ aliases: [{ source: 'fasta_header', identifier: 'sp|P02649|APOE_HUMAN' }] }),
    'APOE_HUMAN',
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
