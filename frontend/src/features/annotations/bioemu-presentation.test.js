import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjacentConformerIndex,
  clampConformerIndex,
  classifyBioEmuTrajectoryError,
  findSequenceChain,
  getPublishedFrustratometerValue,
  extractBioEmuTarArtifacts,
  formatBioEmuConformerCounter,
  hasPublishedBioEmuTopology,
  latestBioEmuRunWithTopology,
  parseBioEmuMetadata,
  parseFrameIndex,
  parsePdbSummary,
  resolveBioEmuArtifacts,
  validatePdbSequenceCompatibility,
  validateBioEmuFrameCount,
  bioEmuProteinIdentifier,
} from './bioemu-presentation.js';

const encoder = new TextEncoder();

function pdbAtom(serial, residueName, chain, sequenceId, model = 1, insertionCode = ' ') {
  const atomName = ' CA ';
  return `${'ATOM  '}${String(serial).padStart(5)} ${atomName} ${String(residueName).padStart(3)} ${chain}${String(sequenceId).padStart(4)}${insertionCode}   ${'  10.000'.padStart(8)}${'  11.000'.padStart(8)}${'  12.000'.padStart(8)}${'  1.00'.padStart(6)}${' 20.00'.padStart(6)}          C `;
}

function tarField(target, offset, length, value) {
  target.set(encoder.encode(String(value)).subarray(0, length), offset);
}

function tarHeader(name, size, type = '0') {
  const header = new Uint8Array(512);
  tarField(header, 0, 100, name);
  tarField(header, 100, 8, '0000600');
  tarField(header, 108, 8, '0000000');
  tarField(header, 116, 8, '0000000');
  tarField(header, 124, 12, `${size.toString(8).padStart(11, '0')} `);
  tarField(header, 136, 12, '00000000000 ');
  tarField(header, 148, 8, '        ');
  tarField(header, 156, 1, type);
  tarField(header, 257, 6, 'ustar');
  tarField(header, 263, 2, '00');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function tarPaxPath(path) {
  const content = `path=${path}\n`;
  const contentLength = encoder.encode(content).length;
  let length = contentLength + 3;
  while (String(length).length + 1 + contentLength !== length) length = String(length).length + 1 + contentLength;
  return encoder.encode(`${length} ${content}`);
}

function tarArchive(entries) {
  const blocks = [];
  const add = (bytes) => {
    const block = new Uint8Array(Math.max(1, Math.ceil(bytes.length / 512)) * 512);
    block.set(bytes);
    blocks.push(block);
  };
  for (const entry of entries) {
    const payload = encoder.encode(entry.content);
    if (entry.paxPath) {
      const pax = tarPaxPath(entry.paxPath);
      blocks.push(tarHeader('PaxHeader', pax.length, 'x'));
      add(pax);
    }
    blocks.push(tarHeader(entry.name, payload.length));
    add(payload);
  }
  const result = new Uint8Array(blocks.reduce((total, block) => total + block.length, 1024));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return new Blob([result], { type: 'application/x-tar' });
}

test('BioEmu artifact resolver scopes topology, trajectory, metadata, and metrics to their publishing stages', () => {
  const topology = { id: 'pdb', artifact_type: 'topology', download_filename: 'topology.pdb', media_type: 'chemical/x-pdb' };
  const trajectory = { id: 'xtc', artifact_type: 'samples_xtc', download_filename: 'samples.xtc', media_type: 'application/octet-stream' };
  const metadata = { id: 'meta', artifact_type: 'metadata' };
  const frames = { id: 'frames', artifact_type: 'frames_index' };
  const finalDirectory = { id: 'final-dir', artifact_type: 'conformational_ensemble_final_dir', media_type: 'application/x-tar' };
  const metrics = { id: 'metrics', artifact_type: 'frustratometer_conformers' };
  const run = { stages: [
    { id: 'conformational_ensemble', artifacts: [topology, trajectory, metadata, frames] },
    { id: 'ensemble_frustration', artifacts: [metrics] },
    { id: 'other_stage', artifacts: [{ id: 'foreign', artifact_type: 'metadata' }] },
  ] };
  assert.deepEqual(resolveBioEmuArtifacts(run), {
    stage: run.stages[0], topology, referencePdb: null, trajectory, finalDirectory: null, metadata, frameIndex: frames, conformerMetrics: metrics,
  });
  const withoutXtc = resolveBioEmuArtifacts({ stages: [{ id: 'conformational_ensemble', artifacts: [topology, metadata] }] });
  assert.equal(withoutXtc.trajectory, null);
  assert.equal(withoutXtc.metadata, metadata);
});

test('BioEmu can use the run relaxed PDB as a reference when no conformer topology was published', () => {
  const relaxed = { id: 'relaxed', artifact_type: 'rosettamp_relaxed_pdb', media_type: 'application/octet-stream' };
  const selected = { id: 'selected', artifact_type: 'selected_reference_pdb', media_type: 'application/octet-stream' };
  const model = { id: 'model', artifact_type: 'model_cif', media_type: 'chemical/x-mmcif' };
  const artifacts = resolveBioEmuArtifacts({ stages: [{ id: 'protein_relaxation_energy', artifacts: [selected, model, relaxed] }] });

  assert.equal(artifacts.topology, null);
  assert.equal(artifacts.referencePdb, relaxed);
});

test('resolves the final directory TAR and selects the newest successful run with a published topology source', () => {
  const oldRun = {
    id: 'old', protein_id: 'p1', created_at: '2026-01-01',
    stages: [{ id: 'conformational_ensemble', status: 'success', artifacts: [{ artifact_type: 'topology' }] }],
  };
  const newRunWithoutFiles = {
    id: 'new-empty', protein_id: 'p1', created_at: '2026-02-01',
    stages: [{ id: 'conformational_ensemble', status: 'success', artifacts: [] }],
  };
  const pendingRun = {
    id: 'pending', protein_id: 'p1', created_at: '2026-03-01',
    stages: [{ id: 'conformational_ensemble', status: 'pending', artifacts: [{ artifact_type: 'conformational_ensemble_final_dir' }] }],
  };
  const newestWithArchive = {
    id: 'archive', protein_id: 'p1', created_at: '2026-02-15',
    stages: [{ id: 'conformational_ensemble', status: 'reused', artifacts: [{ id: 'dir', artifact_type: 'conformational_ensemble_final_dir' }] }],
  };
  assert.equal(hasPublishedBioEmuTopology(pendingRun), false);
  assert.equal(latestBioEmuRunWithTopology([oldRun, newRunWithoutFiles, pendingRun, newestWithArchive], 'p1'), newestWithArchive);
  assert.equal(latestBioEmuRunWithTopology([newRunWithoutFiles, pendingRun], 'p1'), null);
  assert.equal(resolveBioEmuArtifacts(newestWithArchive).finalDirectory.id, 'dir');
});

test('extracts the published PDB, XTC and optional metadata from a PAX TAR directory artifact', async () => {
  const archive = tarArchive([
    { name: 'BioEmu/topology.pdb', paxPath: 'BioEmu/output with spaces/topology.pdb', content: 'ATOM\nEND' },
    { name: 'BioEmu/samples.xtc', content: 'xtc-bytes' },
    { name: 'BioEmu/metadata.json', content: '{"ensemble_size":2}' },
    { name: 'BioEmu/frames_index.tsv', content: 'table_row\n0\n1\n' },
    { name: '../unsafe/samples.xtc', content: 'unsafe-bytes' },
  ]);

  const members = await extractBioEmuTarArtifacts(archive);

  assert.equal(members.topology.path, 'BioEmu/output with spaces/topology.pdb');
  assert.equal(await members.topology.blob.text(), 'ATOM\nEND');
  assert.equal(await members.trajectory.blob.text(), 'xtc-bytes');
  assert.equal(await members.metadata.blob.text(), '{"ensemble_size":2}');
  assert.equal(await members.frameIndex.blob.text(), 'table_row\n0\n1\n');
});

test('rejects duplicate published XTC files and truncated TAR members rather than choosing silently', async () => {
  const duplicate = tarArchive([
    { name: 'run-a/samples.xtc', content: 'one' },
    { name: 'run-b/samples.xtc', content: 'two' },
  ]);
  await assert.rejects(extractBioEmuTarArtifacts(duplicate), /más de un archivo samples\.xtc/);

  const truncated = new Blob([tarHeader('samples.xtc', 10), encoder.encode('short')], { type: 'application/x-tar' });
  await assert.rejects(extractBioEmuTarArtifacts(truncated), /excede el tamaño publicado/);
});

test('metadata and frame-index parsing retain real counts and missing values', () => {
  const metadata = parseBioEmuMetadata(JSON.stringify({
    model: 'bioemu-v1.2', protein_id: 'P02649', ensemble_size: 207,
    raw_samples: 1250, sequence_length: 317, coordinate_unit: 'angstrom',
  }));
  assert.equal(metadata.conformerCount, 207);
  assert.equal(metadata.rawSampleCount, 1250);
  assert.equal(metadata.sequenceLength, 317);
  assert.equal(metadata.coordinateUnit, 'angstrom');
  assert.equal(parseBioEmuMetadata('{broken'), null);
  assert.equal(parseBioEmuMetadata('{"ensemble_size":null,"raw_samples":""}').conformerCount, null);

  const index = parseFrameIndex('table_row\tround\txtc_frame\n0\t0\t0\n1\t0\t1\n2\t1\t0\n');
  assert.equal(index.length, 3);
  assert.deepEqual(index[2], { rowIndex: 2, round: 1, sourceFrame: 0 });
  assert.equal(validateBioEmuFrameCount(3, { conformerCount: 3 }, index), null);
  assert.match(validateBioEmuFrameCount(4, { conformerCount: 3 }, index), /XTC contiene 4 conformeros/);
  assert.match(validateBioEmuFrameCount(3, null, index.slice(0, 2)), /índice publicado contiene 2 filas/);
  assert.match(validateBioEmuFrameCount(3, null, [index[0], index[0], index[2]]), /duplicadas o discontinuas/);
  const partialIndex = parseFrameIndex('table_row\tround\txtc_frame\n0\t\t\n\t1\t2\n');
  assert.deepEqual(partialIndex, [
    { rowIndex: 0, round: null, sourceFrame: null },
  ]);
});

test('PDB summary counts first-model atoms and residues and maps an exact chain sequence', () => {
  const pdb = [
    'MODEL        1',
    pdbAtom(1, 'ALA', 'A', 10, 1),
    pdbAtom(2, 'ALA', 'A', 10, 1),
    pdbAtom(3, 'CYS', 'A', 11, 1, 'A'),
    'ENDMDL',
    'MODEL        2',
    pdbAtom(4, 'GLY', 'B', 1, 2),
    'ENDMDL',
  ].join('\n');
  const summary = parsePdbSummary(pdb);
  assert.equal(summary.atomCount, 3);
  assert.equal(summary.residueCount, 2);
  assert.equal(summary.modelCount, 2);
  assert.equal(summary.chains[0].sequence, 'AC');
  assert.equal(summary.chains[0].residues[1].authSequenceId, '11');
  assert.equal(summary.chains[0].residues[1].insertionCode, 'A');
  assert.equal(findSequenceChain(summary, 'AC'), summary.chains[0]);
  assert.equal(findSequenceChain(summary, 'AG'), null);
  assert.equal(validatePdbSequenceCompatibility('AC', summary, { sequenceLength: 2 }), '');
  assert.match(validatePdbSequenceCompatibility('AG', summary, { sequenceLength: 2 }), /no coincide/);
  assert.match(validatePdbSequenceCompatibility('AC', summary, { sequenceLength: 3 }), /publica una secuencia de 3/);
});

test('maps a unique exact subsequence for a static structure preview without accepting it for trajectory playback', () => {
  const pdb = [
    pdbAtom(1, 'GLY', 'A', 25, 1),
    pdbAtom(2, 'ALA', 'A', 26, 1),
    pdbAtom(3, 'CYS', 'A', 27, 1),
    pdbAtom(4, 'ASP', 'A', 28, 1),
  ].join('\n');
  const summary = parsePdbSummary(pdb);
  const mapped = findSequenceChain(summary, 'AC');

  assert.equal(mapped.sequence, 'AC');
  assert.equal(mapped.sequenceOffset, 1);
  assert.deepEqual(mapped.residues.map((residue) => residue.authSequenceId), ['26', '27']);
  assert.match(validatePdbSequenceCompatibility('AC', summary, null), /no coincide/);
});

test('does not map an ambiguous repeated subsequence to one PDB region', () => {
  const summary = { chains: [{ chainId: 'A', sequence: 'ACAC', residues: Array(4).fill({}) }] };
  assert.equal(findSequenceChain(summary, 'AC'), null);
});

test('Mol* atom-count incompatibility becomes an understandable stop state', () => {
  assert.deepEqual(classifyBioEmuTrajectoryError(new Error('Frame element count mismatch, got 10 but expected 12')), {
    state: 'incompatible',
    message: 'El modelo de referencia y la trayectoria tienen distinto número de átomos. La reproducción se detuvo y se conserva la estructura de referencia.',
  });
  assert.deepEqual(classifyBioEmuTrajectoryError(new Error('invalid xtc magic')), {
    state: 'error',
    message: 'No se pudo cargar la trayectoria de conformeros. La reproducción se detuvo y se conserva la estructura de referencia.',
  });
});

test('protein identifiers come only from published metadata or biological aliases', () => {
  assert.equal(bioEmuProteinIdentifier({ proteinId: 'P02649' }, null, { id: 'internal-uuid' }), 'P02649');
  assert.equal(bioEmuProteinIdentifier(null, { configuration: { scientific_accession: 'P02649' } }, { id: 'internal-uuid' }), 'P02649');
  assert.equal(bioEmuProteinIdentifier(null, null, { id: 'internal-uuid', aliases: [{ source: 'UniProt', identifier: 'P02649' }] }), 'P02649');
  assert.equal(bioEmuProteinIdentifier(null, null, { id: 'internal-uuid', aliases: [{ source: 'gene', identifier: 'APOE' }] }), null);
});

test('per-conformer Frustratometer FI is shown only when a real value exists for that residue', () => {
  const rows = [
    { conformation: 'conf_0000', '0_M': '-0.25', '1_A': '' },
    { conformation: 'conf_0001', '0_M': '0.75', '1_A': 'NA' },
  ];
  const value = getPublishedFrustratometerValue(rows, 1, 1, 'M', 2);
  assert.equal(value.value, 0.75);
  assert.equal(value.unit, null);
  assert.equal(value.source, 'frustratometer_conformers');
  assert.match(value.explanation, /no representa energía/);
  assert.equal(getPublishedFrustratometerValue(rows, 0, 2, 'A', 2), null);
  assert.equal(getPublishedFrustratometerValue(rows, 0, 1, 'M', 3), null);
  assert.equal(getPublishedFrustratometerValue(rows, 0, 1, 'M', 2).value, -0.25);
  assert.equal(getPublishedFrustratometerValue([
    { conformation: 'conf_0001', '0_M': '9' },
    { conformation: 'conf_0000', '0_M': '8' },
  ], 0, 1, 'M', 2), null);
});

test('frame indices are zero-based, clamped, and adapt to small or 207-frame ensembles', () => {
  assert.equal(clampConformerIndex(-4, 207), 0);
  assert.equal(clampConformerIndex(900, 207), 206);
  assert.equal(clampConformerIndex(2.8, 4), 2);
  assert.equal(clampConformerIndex(0, 1), 0);
  assert.equal(clampConformerIndex(0, 0), null);
  assert.equal(adjacentConformerIndex(0, 4, -1, false), 0);
  assert.equal(adjacentConformerIndex(3, 4, 1, false), 3);
  assert.equal(adjacentConformerIndex(3, 4, 1, true), 0);
  assert.equal(adjacentConformerIndex(0, 4, -1, true), 3);
  assert.equal(adjacentConformerIndex(0, 1, 1, true), 0);
});

test('the sidebar conformer counter is one-based and padded to at least three digits', () => {
  assert.equal(formatBioEmuConformerCounter(0, 207), '001/207');
  assert.equal(formatBioEmuConformerCounter(99, 207), '100/207');
  assert.equal(formatBioEmuConformerCounter(206, 207), '207/207');
  assert.equal(formatBioEmuConformerCounter(0, 8), '001/008');
  assert.equal(formatBioEmuConformerCounter(1233, 1300), '1234/1300');
  assert.equal(formatBioEmuConformerCounter(null, 207), '—');
});
