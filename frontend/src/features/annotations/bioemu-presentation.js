import { parseAnalysisArtifact } from './analysis-artifacts.js';

export const BIOEMU_REFERENCE_URL = 'https://doi.org/10.1038/s41467-023-43801-2';

const THREE_TO_ONE = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H',
  ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W',
  TYR: 'Y', VAL: 'V', SEC: 'U', PYL: 'O', ASX: 'B', GLX: 'Z',
};

const TAR_BLOCK_BYTES = 512;
const TAR_MAX_ENTRIES = 100_000;
const TAR_MAX_METADATA_BYTES = 1024 * 1024;

function artifactName(artifact) {
  return [artifact?.download_filename, artifact?.display_name, artifact?.artifact_type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function findArtifact(artifacts, predicate) {
  return artifacts.find(predicate) ?? null;
}

export function resolveBioEmuArtifacts(run) {
  const stage = (run?.stages ?? []).find((item) => item.id === 'conformational_ensemble');
  const artifacts = stage?.artifacts ?? [];
  const topology = findArtifact(artifacts, (item) => (
    item.artifact_type === 'topology'
    || /(?:^|[\\/])topology(?:[-_][^/\\]*)?\.pdb$/.test(artifactName(item))
    || (/\.pdb(?:\s|$)/.test(artifactName(item)) && item.media_type?.toLowerCase().includes('pdb'))
  ));
  const trajectory = findArtifact(artifacts, (item) => (
    item.artifact_type === 'samples_xtc'
    || /(?:^|[\\/])samples\.xtc$/.test(artifactName(item))
    || /\.xtc(?:\s|$)/.test(artifactName(item))
  ));
  const finalDirectory = findArtifact(artifacts, (item) => item.artifact_type === 'conformational_ensemble_final_dir');
  const metadata = findArtifact(artifacts, (item) => item.artifact_type === 'metadata');
  const frameIndex = findArtifact(artifacts, (item) => item.artifact_type === 'frames_index');
  const conformerMetrics = (run?.stages ?? [])
    .find((item) => item.id === 'ensemble_frustration')
    ?.artifacts?.find((item) => item.artifact_type === 'frustratometer_conformers') ?? null;

  return { stage: stage ?? null, topology, trajectory, finalDirectory, metadata, frameIndex, conformerMetrics };
}

export function hasPublishedBioEmuTopology(run) {
  const stage = (run?.stages ?? []).find((item) => item.id === 'conformational_ensemble');
  if (!['success', 'reused'].includes(String(stage?.status ?? '').toLowerCase())) return false;
  const artifacts = resolveBioEmuArtifacts(run);
  return Boolean(artifacts.topology || artifacts.finalDirectory);
}

export function latestBioEmuRunWithTopology(runs, proteinId) {
  return (runs ?? [])
    .filter((run) => run?.protein_id === proteinId && hasPublishedBioEmuTopology(run))
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0] ?? null;
}

function decodeTarText(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
}

function tarTextField(bytes, offset, length) {
  return decodeTarText(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, '').trim();
}

function tarOctalField(bytes, offset, length) {
  const raw = tarTextField(bytes, offset, length).replace(/^\s+|\s+$/g, '');
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseTarPax(bytes) {
  const attributes = {};
  let offset = 0;
  while (offset < bytes.length) {
    let space = offset;
    while (space < bytes.length && bytes[space] !== 0x20) space += 1;
    if (space === bytes.length) throw new Error('El TAR de BioEmu contiene metadatos PAX inválidos.');
    const length = Number.parseInt(decodeTarText(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length < 3 || offset + length > bytes.length) {
      throw new Error('El TAR de BioEmu contiene una longitud PAX inválida.');
    }
    const end = offset + length;
    const record = bytes.subarray(space + 1, end - (bytes[end - 1] === 0x0a ? 1 : 0));
    const equals = record.indexOf(0x3d);
    if (equals > 0) {
      attributes[decodeTarText(record.subarray(0, equals))] = decodeTarText(record.subarray(equals + 1));
    }
    offset = end;
  }
  return attributes;
}

function safeTarMemberPath(path) {
  const value = String(path ?? '').replace(/^(?:\.\/)+/, '');
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return '';
  const parts = value.split('/').filter((part) => part !== '');
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return '';
  return parts.join('/');
}

function tarHeaderPath(header, paxAttributes, longName) {
  if (paxAttributes.path) return paxAttributes.path;
  if (longName) return longName;
  const name = tarTextField(header, 0, 100);
  const prefix = tarTextField(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function isTarRegularFile(typeFlag) {
  return typeFlag === 0 || typeFlag === 48 || typeFlag === 55;
}

function isZeroTarBlock(bytes) {
  return bytes.every((value) => value === 0);
}

function tarTargetName(path) {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'topology.pdb') return 'topology';
  if (base === 'samples.xtc') return 'trajectory';
  if (base === 'metadata.json' || base === 'metadata') return 'metadata';
  if (/^frames_index\.(?:tsv|csv)$/.test(base) || base === 'frames_index') return 'frameIndex';
  return '';
}

/** Locate the explicitly published BioEmu files in the backend's PAX TAR directory artifact. */
export async function extractBioEmuTarArtifacts(value) {
  if (!(value instanceof Blob)) throw new TypeError('El artefacto TAR de BioEmu debe ser un Blob.');
  const members = {};
  let offset = 0;
  let entries = 0;
  let terminated = false;
  let globalPax = {};
  let pendingPax = {};
  let pendingLongName = '';

  while (offset + TAR_BLOCK_BYTES <= value.size) {
    const header = new Uint8Array(await value.slice(offset, offset + TAR_BLOCK_BYTES).arrayBuffer());
    if (header.byteLength !== TAR_BLOCK_BYTES) throw new Error('El TAR de BioEmu termina dentro de una cabecera.');
    if (isZeroTarBlock(header)) {
      terminated = true;
      break;
    }
    entries += 1;
    if (entries > TAR_MAX_ENTRIES) throw new Error('El TAR de BioEmu contiene demasiados archivos.');

    const headerSize = tarOctalField(header, 124, 12);
    if (headerSize === null) throw new Error('El TAR de BioEmu contiene un tamaño de archivo inválido.');
    const typeFlag = header[156] ?? 0;
    const paxSize = isTarRegularFile(typeFlag) ? ({ ...globalPax, ...pendingPax }).size : null;
    const memberSize = paxSize === null || paxSize === undefined
      ? headerSize
      : /^\d+$/.test(String(paxSize)) && Number.isSafeInteger(Number(paxSize)) ? Number(paxSize) : null;
    if (memberSize === null) throw new Error('El TAR de BioEmu contiene un tamaño PAX inválido.');
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + memberSize;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > value.size) throw new Error('Un archivo del TAR de BioEmu excede el tamaño publicado.');
    if (typeFlag === 120 || typeFlag === 103 || typeFlag === 76) {
      if (memberSize > TAR_MAX_METADATA_BYTES) throw new Error('Los metadatos de ruta del TAR de BioEmu son demasiado grandes.');
      const metadataBytes = new Uint8Array(await value.slice(dataStart, dataEnd).arrayBuffer());
      if (typeFlag === 120) pendingPax = parseTarPax(metadataBytes);
      else if (typeFlag === 103) globalPax = { ...globalPax, ...parseTarPax(metadataBytes) };
      else pendingLongName = decodeTarText(metadataBytes).replace(/\n+$/, '');
    } else {
      if (isTarRegularFile(typeFlag)) {
        const pax = { ...globalPax, ...pendingPax };
        const path = safeTarMemberPath(tarHeaderPath(header, pax, pendingLongName));
        const key = path ? tarTargetName(path) : '';
        if (key) {
          if (members[key]) throw new Error(`El TAR de BioEmu contiene más de un archivo ${key === 'topology' ? 'topology.pdb' : key === 'trajectory' ? 'samples.xtc' : key}.`);
          const mediaType = key === 'topology' ? 'chemical/x-pdb'
            : key === 'trajectory' ? 'application/octet-stream'
              : key === 'metadata' ? 'application/json'
                : path.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/tab-separated-values';
          members[key] = { path, blob: value.slice(dataStart, dataEnd, mediaType), mediaType };
        }
      }
      pendingPax = {};
      pendingLongName = '';
    }

    const nextOffset = dataStart + Math.ceil(memberSize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > value.size) {
      throw new Error('El TAR de BioEmu contiene un desplazamiento inválido.');
    }
    offset = nextOffset;
  }

  if (!terminated) throw new Error('El TAR de BioEmu está truncado o no tiene su terminador.');
  return members;
}

export function parseBioEmuMetadata(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const positiveInteger = (candidate) => {
      if (candidate === null || candidate === undefined || candidate === '') return null;
      const number = Number(candidate);
      return Number.isInteger(number) && number >= 0 ? number : null;
    };
    return {
      raw: value,
      proteinId: typeof value.protein_id === 'string' ? value.protein_id : null,
      model: typeof value.model === 'string' ? value.model : null,
      conformerCount: positiveInteger(value.ensemble_size) ?? positiveInteger(value.qc_retained_total),
      rawSampleCount: positiveInteger(value.raw_samples),
      sequenceLength: positiveInteger(value.sequence_length),
      coordinateUnit: typeof value.coordinate_unit === 'string' ? value.coordinate_unit : null,
      roundsCompleted: positiveInteger(value.bioemu_rounds_done),
      alignment: typeof value.alignment === 'string' ? value.alignment : null,
      selection: typeof value.selection === 'string' ? value.selection : null,
    };
  } catch {
    return null;
  }
}

export function bioEmuProteinIdentifier(metadata, run, protein) {
  const value = [
    metadata?.proteinId,
    run?.configuration?.scientific_accession,
    protein?.aliases?.find((alias) => String(alias?.source ?? '').toLowerCase() === 'uniprot')?.identifier,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim());
  return value?.trim() ?? null;
}

export function parseFrameIndex(text, mediaType = 'text/tab-separated-values') {
  const nonnegativeInteger = (value) => {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  };
  return parseAnalysisArtifact(text, mediaType)
    .map((row) => {
      const rowIndex = nonnegativeInteger(row.table_row);
      const round = nonnegativeInteger(row.round);
      const sourceFrame = nonnegativeInteger(row.xtc_frame);
      if (rowIndex === null) return null;
      return {
        rowIndex,
        round,
        sourceFrame,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.rowIndex - b.rowIndex);
}

export function parseConformerMetrics(text, mediaType = 'text/tab-separated-values') {
  return parseAnalysisArtifact(text, mediaType);
}

export function getPublishedFrustratometerValue(rows, conformerIndex, residuePosition, residueCode, frameCount) {
  if (!Array.isArray(rows) || rows.length !== frameCount) return null;
  if (!Number.isInteger(conformerIndex) || conformerIndex < 0 || conformerIndex >= rows.length) return null;
  if (!Number.isInteger(residuePosition) || residuePosition < 1) return null;
  const row = rows[conformerIndex];
  const publishedName = String(row?.conformation ?? row?.conformer ?? row?.conformer_id ?? '').trim();
  if (publishedName) {
    const match = publishedName.match(/^(?:conf(?:ormation)?[_-]?)?(\d+)$/i);
    if (!match || Number(match[1]) !== conformerIndex) return null;
  }
  const key = `${residuePosition - 1}_${String(residueCode ?? '').toUpperCase()}`;
  if (!row || !Object.hasOwn(row, key)) return null;
  const raw = String(row[key] ?? '').trim();
  if (!raw || ['na', 'n/a', 'nan', 'null', 'none'].includes(raw.toLowerCase())) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return {
    name: 'Frustratometer FI',
    value,
    unit: null,
    source: 'frustratometer_conformers',
    explanation: 'Índice publicado por residuo para este conformero; no representa energía ni confianza.',
    referenceUrl: BIOEMU_REFERENCE_URL,
  };
}

export function parsePdbSummary(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const modelRecords = lines.filter((line) => line.startsWith('MODEL '));
  const explicitModels = modelRecords.length;
  const firstModel = explicitModels ? String(modelRecords[0].slice(10).trim()) : null;
  const chains = new Map();
  let atomCount = 0;
  let inFirstModel = !explicitModels;
  let exitedFirstModel = false;

  for (const line of lines) {
    if (line.startsWith('MODEL ')) {
      const model = String(line.slice(10).trim());
      inFirstModel = !exitedFirstModel && model === firstModel;
      continue;
    }
    if (line.startsWith('ENDMDL')) {
      if (inFirstModel) exitedFirstModel = true;
      inFirstModel = false;
      continue;
    }
    if (!inFirstModel || (!line.startsWith('ATOM  ') && !line.startsWith('HETATM'))) continue;
    atomCount += 1;
    const chainId = String(line.slice(21, 22)).trim();
    const residueName = String(line.slice(17, 20)).trim().toUpperCase();
    const authSequenceId = String(line.slice(22, 26)).trim();
    const insertionCode = String(line.slice(26, 27)).trim();
    const residueCode = THREE_TO_ONE[residueName];
    if (!residueCode || !authSequenceId) continue;
    if (!chains.has(chainId)) chains.set(chainId, new Map());
    const residues = chains.get(chainId);
    const key = `${authSequenceId}|${insertionCode}`;
    if (!residues.has(key)) residues.set(key, { chainId, authSequenceId, insertionCode, residueCode, residueName });
  }

  const chainRows = [...chains.entries()].map(([chainId, residues]) => {
    const residueList = [...residues.values()];
    return { chainId, residues: residueList, sequence: residueList.map((item) => item.residueCode).join('') };
  });
  const totalResidues = chainRows.reduce((total, chain) => total + chain.residues.length, 0);
  return {
    atomCount,
    residueCount: totalResidues,
    modelCount: explicitModels || (atomCount ? 1 : 0),
    chains: chainRows,
  };
}

export function findSequenceChain(summary, sequence) {
  const target = String(sequence ?? '').replace(/\s/g, '').toUpperCase();
  if (!target) return null;
  return summary?.chains?.find((chain) => chain.sequence === target) ?? null;
}

export function validatePdbSequenceCompatibility(proteinSequence, summary, metadata) {
  const targetLength = String(proteinSequence ?? '').length;
  if (metadata?.sequenceLength !== null && metadata?.sequenceLength !== undefined && metadata.sequenceLength !== targetLength) {
    return `La corrida publica una secuencia de ${metadata.sequenceLength} residuos, pero la proteína tiene ${targetLength}. No se cargará la trayectoria.`;
  }
  if (!findSequenceChain(summary, proteinSequence)) {
    return 'La secuencia de la estructura de referencia no coincide con la proteína seleccionada. No se puede reproducir la trayectoria.';
  }
  return '';
}

export function classifyBioEmuTrajectoryError(error) {
  const message = String(error?.message ?? error ?? '');
  if (/element count mismatch|atom count|number of atoms|atom number/i.test(message)) {
    return {
      state: 'incompatible',
      message: 'El modelo de referencia y la trayectoria tienen distinto número de átomos. La reproducción se detuvo y se conserva la estructura de referencia.',
    };
  }
  return {
    state: 'error',
    message: 'No se pudo cargar la trayectoria de conformeros. La reproducción se detuvo y se conserva la estructura de referencia.',
  };
}

export function clampConformerIndex(index, frameCount) {
  const count = Math.max(0, Math.trunc(Number(frameCount) || 0));
  if (!count) return null;
  const candidate = Number(index);
  return Math.min(count - 1, Math.max(0, Math.trunc(Number.isFinite(candidate) ? candidate : 0)));
}

export function adjacentConformerIndex(index, frameCount, direction, loop = false) {
  const current = clampConformerIndex(index, frameCount);
  if (current === null) return null;
  const count = Math.max(0, Math.trunc(Number(frameCount) || 0));
  const next = current + (direction < 0 ? -1 : 1);
  if (next < 0 || next >= count) return loop ? (next < 0 ? count - 1 : 0) : current;
  return next;
}

export function formatBioEmuConformerCounter(index, frameCount) {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(frameCount) || frameCount < 1) return '—';
  const current = String(index + 1).padStart(3, '0');
  const total = String(frameCount).padStart(3, '0');
  return `${current}/${total}`;
}

export function validateBioEmuFrameCount(frameCount, metadata, frameIndex, sourceLabel = 'XTC') {
  if (!Number.isInteger(frameCount) || frameCount < 1) return 'La trayectoria no contiene conformeros.';
  if (metadata?.conformerCount !== null && metadata?.conformerCount !== undefined && metadata.conformerCount !== frameCount) {
    return `${sourceLabel} contiene ${frameCount} conformeros y los metadatos publican ${metadata.conformerCount}.`;
  }
  if (Array.isArray(frameIndex) && frameIndex.length && frameIndex.length !== frameCount) {
    return `${sourceLabel} contiene ${frameCount} conformeros y el índice publicado contiene ${frameIndex.length} filas.`;
  }
  if (Array.isArray(frameIndex) && frameIndex.some((item, index) => item.rowIndex !== index)) {
    return 'El índice publicado contiene filas duplicadas o discontinuas; no se asociarán sus propiedades a los conformeros.';
  }
  return null;
}
