import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultStructureOption,
  structureGenerationFailed,
  structureGenerationPending,
  structureOptionsForRun,
} from './information-presentation.js';

const artifact = (id, artifact_type, sha256 = `${id}-hash`) => ({
  id,
  artifact_type,
  media_type: artifact_type === 'model_cif' ? 'chemical/x-mmcif' : 'chemical/x-pdb',
  sha256,
});

test('lists input PDB, AF3, and relaxed structures in scientific source order', () => {
  const run = {
    configuration: { structure_upload_id: 'upload-pdb' },
    uploads: [{
      id: 'upload-pdb',
      input_type: 'structure',
      original_filename: 'reference.pdb',
      media_type: 'chemical/x-pdb',
      sha256: 'input-hash',
    }],
    stages: [{
      artifacts: [
        artifact('reference', 'selected_reference_pdb'),
        artifact('relaxed', 'rosettamp_relaxed_pdb'),
        artifact('af3', 'model_cif'),
      ],
    }],
  };

  const options = structureOptionsForRun(run);
  assert.deepEqual(options.map(({ kind }) => kind), ['provided', 'alphafold3', 'relaxed', 'reference']);
  assert.equal(defaultStructureOption(options).id, 'upload-pdb');
  assert.deepEqual(options.map(({ format }) => format), ['pdb', 'mmcif', 'pdb', 'pdb']);
});

test('prefers AlphaFold 3 when there is no input PDB and relaxed structure otherwise', () => {
  const af3Run = { run_artifacts: [artifact('af3', 'model_cif')] };
  const relaxedRun = { run_artifacts: [artifact('relaxed', 'foldx_relaxed_pdb')] };
  const referenceRun = { run_artifacts: [artifact('reference', 'selected_reference_pdb')] };
  const relaxedAndReferenceRun = {
    run_artifacts: [artifact('reference', 'selected_reference_pdb'), artifact('relaxed', 'foldx_relaxed_pdb')],
  };

  assert.equal(defaultStructureOption(structureOptionsForRun(af3Run)).kind, 'alphafold3');
  assert.equal(defaultStructureOption(structureOptionsForRun(relaxedRun)).kind, 'relaxed');
  assert.equal(defaultStructureOption(structureOptionsForRun(referenceRun)).kind, 'reference');
  assert.equal(defaultStructureOption(structureOptionsForRun(relaxedAndReferenceRun)).kind, 'relaxed');
  assert.equal(defaultStructureOption([]), null);
});

test('omits a selected reference when it has the exact input PDB checksum', () => {
  const run = {
    configuration: { structure_upload_id: 'input' },
    uploads: [{
      id: 'input',
      input_type: 'structure',
      original_filename: 'reference.pdb',
      media_type: 'chemical/x-pdb',
      sha256: 'same-hash',
    }],
    run_artifacts: [artifact('reference', 'selected_reference_pdb', 'same-hash')],
  };

  assert.deepEqual(structureOptionsForRun(run).map(({ kind }) => kind), ['provided']);
});

test('reports structure generation only while its pipeline stages are active or failed', () => {
  assert.equal(structureGenerationPending({ stages: [{ id: 'structure_modeling', status: 'running' }] }), true);
  assert.equal(structureGenerationPending({ stages: [{ id: 'protein_relaxation_energy', status: 'ready' }] }), true);
  assert.equal(structureGenerationPending({ stages: [{ id: 'structure_modeling', status: 'failed' }] }), false);
  assert.equal(structureGenerationPending({ stages: [{ id: 'variant_ddg', status: 'running' }] }), false);
  assert.equal(structureGenerationFailed({ stages: [{ id: 'structure_modeling', status: 'failed' }] }), true);
  assert.equal(structureGenerationFailed({ stages: [{ id: 'structure_modeling', status: 'success' }] }), false);
});
