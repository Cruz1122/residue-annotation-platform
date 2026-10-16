import assert from 'node:assert/strict';
import test from 'node:test';
import { runPhase } from './run-phase.js';
import { presentRunStages, progressSummary, validateDisabledStages } from './stage-visibility.js';

const DEPENDENCIES = {
  protein_identity: [],
  variant_predictors: ['protein_identity'],
  pharmacogenomics: ['protein_identity'],
  uniprot_features: ['protein_identity'],
  conformational_ensemble: ['protein_identity', 'structure_modeling'],
  sequence_frustration: ['protein_identity'],
  evolutionary_conservation: ['uniprot_features'],
  functional_region_evidence: ['uniprot_features'],
  experimental_variant_evidence: ['uniprot_features'],
  membrane_topology: ['uniprot_features'],
  ensemble_frustration: ['conformational_ensemble'],
  structure_modeling: ['membrane_topology'],
  structural_regime: ['structure_modeling'],
  protein_relaxation_energy: ['structural_regime'],
  physicochemical_context: ['protein_relaxation_energy'],
  variant_ddg: ['protein_identity', 'membrane_topology', 'protein_relaxation_energy'],
  structural_frustration: ['protein_relaxation_energy'],
  structural_contacts: ['protein_relaxation_energy'],
};

function stages() {
  return Object.entries(DEPENDENCIES).map(([id, dependencies]) => ({
    id,
    dependencies,
    status: 'pending',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: null,
  }));
}

test('the presentation keeps the registry graph valid without inventing disabled stages', () => {
  assert.doesNotThrow(() => validateDisabledStages(stages()));
});

test('omitted AF3 dependencies reconnect to protein identity for a stable progress graph', () => {
  const selectedStages = stages().filter((stage) => stage.id !== 'structure_modeling');
  const presented = presentRunStages(selectedStages);
  const byId = new Map(presented.map((stage) => [stage.id, stage]));

  assert.deepEqual(byId.get('conformational_ensemble').dependencies, ['protein_identity']);
  assert.deepEqual(byId.get('structural_regime').dependencies, ['protein_identity']);
  assert.doesNotThrow(() => validateDisabledStages(presented));
});

test('skipped AF3 stays on the second layer connected to protein identity', () => {
  const withSkippedStructure = stages().map((stage) => (
    stage.id === 'structure_modeling' ? { ...stage, status: 'skipped' } : stage
  ));
  const presented = presentRunStages(withSkippedStructure);
  const structureModeling = presented.find((stage) => stage.id === 'structure_modeling');

  assert.deepEqual(structureModeling.dependencies, ['protein_identity']);
});

test('a disabled parent is rejected', () => {
  assert.throws(
    () => validateDisabledStages(stages(), new Set([
      'protein_identity',
      'variant_predictors',
      'pharmacogenomics',
      'sequence_frustration',
      'ensemble_frustration',
      'evolutionary_conservation',
      'functional_region_evidence',
      'experimental_variant_evidence',
      'physicochemical_context',
    ])),
    /hojas/,
  );
});

test('a provided PDB preserves backend statuses instead of rewriting the graph', () => {
  const presented = presentRunStages(stages());
  const byId = new Map(presented.map((stage) => [stage.id, stage]));
  assert.equal(byId.get('structure_modeling').status, 'pending');
  assert.equal(byId.get('structure_modeling').started_at, '2026-01-01T00:00:00Z');
  assert.equal(byId.get('conformational_ensemble').status, 'pending');
  assert.equal(presented.filter((stage) => stage.status === 'disabled').length, 0);
  assert.equal(byId.get('structural_contacts').status, 'pending');
});

test('the counter includes all registry stages unless the backend marks one disabled', () => {
  const presented = presentRunStages(stages()).map((stage) => (
    stage.id === 'protein_identity' ? { ...stage, status: 'success' } : stage
  ));
  const summary = progressSummary(presented);
  assert.equal(summary.enabled, 18);
  assert.equal(summary.completed, 1);
  assert.equal(summary.percentage, 6);
});

test('retryable preparation stays visible as pending instead of terminal failure', () => {
  const phase = runPhase({
    status: 'pending',
    error_message: 'retry later',
    preparation: { status: 'blocked', error_message: 'Falta el caché externo.' },
    stages: [],
  });
  assert.equal(phase.label, 'Preparación pendiente');
  assert.equal(phase.detail, 'Falta el caché externo.');
  assert.equal(phase.tone, 'failed');
});

test('wait time is normalized to seconds, minutes, and hours', async () => {
  const { formatWaitTime } = await import('./run-phase.js');
  assert.equal(formatWaitTime(59_000), '59s');
  assert.equal(formatWaitTime(60_000), '1m');
  assert.equal(formatWaitTime(3_600_000), '1h');
  assert.equal(formatWaitTime(Number.NaN), '0s');
});
