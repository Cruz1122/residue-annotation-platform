import assert from 'node:assert/strict';
import test from 'node:test';
import { isStructureArtifact, structureFormat } from './structure-format.js';

test('recognizes mmCIF from its published artifact type when MIME metadata is generic', () => {
  const artifact = { artifact_type: 'model_cif', media_type: 'application/octet-stream' };
  assert.equal(isStructureArtifact(artifact), true);
  assert.equal(structureFormat(artifact), 'mmcif');
});

test('uses the published filename to recognize a structure with a generic artifact type', () => {
  const artifact = { artifact_type: 'model', download_filename: 'reference.mmcif', media_type: 'application/octet-stream' };
  assert.equal(isStructureArtifact(artifact), true);
  assert.equal(structureFormat(artifact), 'mmcif');
});

test('recognizes PDB artifact types without relying on MIME metadata', () => {
  const artifact = { artifact_type: 'selected_reference_pdb', media_type: 'application/octet-stream' };
  assert.equal(isStructureArtifact(artifact), true);
  assert.equal(structureFormat(artifact), 'pdb');
});
