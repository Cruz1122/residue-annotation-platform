import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultStructureOption,
  proteinNameForRun,
  sequenceProteinForRun,
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

test('uses the run sequence for a mutant and never substitutes the base sequence while loading', () => {
  const baseProtein = { id: 'base', sequence: 'ALC' };
  const mutantProtein = { id: 'mutant', sequence: 'AQC' };

  assert.equal(sequenceProteinForRun({ protein_id: 'base' }, baseProtein, null), baseProtein);
  assert.equal(sequenceProteinForRun({ protein_id: 'mutant' }, baseProtein, null), null);
  assert.equal(sequenceProteinForRun({ protein_id: 'mutant' }, baseProtein, mutantProtein).sequence, 'AQC');
});

test('uses the canonical base sequence for an external base run linked to a truncated construct', () => {
  const baseProtein = { id: 'canonical', sequence: 'MAVESQ' };
  const constructProtein = { id: 'construct', sequence: 'SHAGK' };
  const baseRun = {
    protein_id: 'construct',
    external_tracking: { run_type: 'base', base_protein_id: 'canonical' },
  };
  const mutantRun = {
    protein_id: 'mutant',
    external_tracking: { run_type: 'mutant', base_protein_id: 'canonical' },
  };

  assert.equal(sequenceProteinForRun(baseRun, baseProtein, constructProtein), baseProtein);
  assert.equal(sequenceProteinForRun(mutantRun, baseProtein, { id: 'mutant', sequence: 'MAVESR' }).sequence, 'MAVESR');
});

test('uses the published identity gene symbol when the local protein has no name', () => {
  assert.equal(proteinNameForRun({}, { external_tracking: { accession: 'P22309' } }, [
    { gene_symbol: 'UGT1A1', uniprot_accession: 'P22309' },
  ]), 'UGT1A1');
  assert.equal(proteinNameForRun({}, { external_tracking: { accession: 'P22309' } }), 'P22309');
  assert.equal(proteinNameForRun({ aliases: [{ source: 'gene', identifier: 'PCSK9' }] }, {}, []), 'PCSK9');
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

test('shows structures from the associated mutant using its scientific run name', () => {
  const ddgRun = {
    id: 'ddg-run',
    external_tracking: { run_type: 'ddg', variant: 'L41Q' },
    run_artifacts: [],
  };
  const mutantRun = {
    id: 'mutant-run',
    external_tracking: { run_type: 'mutant', display_name: 'Q8NBP7-L41Q' },
    run_artifacts: [
      artifact('mutant-model', 'model_cif'),
      artifact('mutant-relaxed', 'rosettamp_relaxed_pdb'),
      artifact('base-reference', 'selected_reference_pdb'),
    ],
  };

  const options = structureOptionsForRun(ddgRun, [mutantRun]);
  assert.deepEqual(options.map(({ kind }) => kind), ['alphafold3', 'relaxed', 'reference']);
  assert.equal(defaultStructureOption(options).sourceRunId, 'mutant-run');
  assert.match(options[0].label, /Q8NBP7-L41Q · Modelo AlphaFold 3/);
  assert.equal(options[1].sourceRun, mutantRun);
});

test('does not invent a label for structures linked to a run without a scientific name', () => {
  const options = structureOptionsForRun({ id: 'ddg-run' }, [{
    id: 'mutant-run',
    run_artifacts: [artifact('mutant-model', 'model_cif')],
  }]);

  assert.equal(options[0].label, 'Modelo AlphaFold 3');
});

test('keeps every published relaxation method available in the selector', () => {
  const options = structureOptionsForRun({
    run_artifacts: [
      artifact('foldx', 'foldx_relaxed_pdb'),
      artifact('rosetta', 'rosettamp_relaxed_pdb'),
    ],
  });

  assert.deepEqual(options.map((option) => option.id), ['rosetta', 'foldx']);
  assert.deepEqual(options.map((option) => option.label), [
    'Estructura relajada · RosettaMP',
    'Estructura relajada · FoldX',
  ]);
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
