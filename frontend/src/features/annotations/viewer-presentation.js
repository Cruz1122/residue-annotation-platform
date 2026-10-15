export const AA3 = {
  A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS', Q: 'GLN', E: 'GLU', G: 'GLY', H: 'HIS',
  I: 'ILE', L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO', S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL',
};

export const AA_NAMES = {
  ALA: 'Alanina', ARG: 'Arginina', ASN: 'Asparagina', ASP: 'Aspartato', CYS: 'Cisteína', GLN: 'Glutamina',
  GLU: 'Glutamato', GLY: 'Glicina', HIS: 'Histidina', ILE: 'Isoleucina', LEU: 'Leucina', LYS: 'Lisina',
  MET: 'Metionina', PHE: 'Fenilalanina', PRO: 'Prolina', SER: 'Serina', THR: 'Treonina', TRP: 'Triptófano',
  TYR: 'Tirosina', VAL: 'Valina',
};

const ONE_FROM_THREE = Object.fromEntries(Object.entries(AA3).map(([one, three]) => [three, one]));

export const MISSING_COLOR = '#b8bec5';

// Presentation tokens. The midpoint of a continuous scale is visual, not a
// validated scientific threshold. Domains come from the current protein.
export const VISUALIZATION_MODES = {
  regime: {
    kind: 'categorical',
    field: 'structural_regime',
    colors: {
      membrane: '#269b65',
      aqueous_folded: '#e5b92e',
      structurally_uncertain: '#d44949',
    },
  },
  frustration: {
    kind: 'continuous',
    field: 'structural_frustration_fi_singleresidue',
    colors: ['#dc4248', '#777980', '#1cb6cc'],
  },
  contacts: {
    kind: 'continuous',
    field: 'structural_contacts_n_contacts',
    colors: ['#2aab71', '#e68a36', '#8745c4'],
  },
  conservation: {
    kind: 'continuous',
    field: 'rate4site_score',
    colors: ['#e7c62f', '#2765d7', '#d243a6'],
  },
};

export const MODE_SCALE_COPY = {
  frustration: {
    magnitude: 'Índice de frustración estructural',
    note: 'Escala relativa a esta proteína. El centro es el punto medio visual, no un umbral neutral.',
    low: 'Menor',
    high: 'Mayor',
  },
  contacts: {
    magnitude: 'Número de contactos',
    note: 'Conteo entero. Escala relativa a esta proteína.',
    low: 'Menos',
    high: 'Más',
  },
  conservation: {
    magnitude: 'rate4site',
    note: 'Escala relativa a esta proteína. Un valor más negativo indica mayor conservación.',
    low: 'Mayor conservación',
    high: 'Menor conservación',
  },
};

export const MODE_INFO = {
  regime: {
    title: 'Régimen estructural',
    icon: 'layers-3',
    legend: [
      ['Membrana', VISUALIZATION_MODES.regime.colors.membrane],
      ['Soluble plegado', VISUALIZATION_MODES.regime.colors.aqueous_folded],
      ['Estructura incierta', VISUALIZATION_MODES.regime.colors.structurally_uncertain],
    ],
  },
  frustration: { title: 'Frustración estructural', icon: 'activity' },
  contacts: { title: 'Contactos estructurales', icon: 'network' },
  conservation: { title: 'Conservación evolutiva', icon: 'scan-search' },
};

const VALUE_LABELS = {
  outside: 'Exterior', inside: 'Interior', tm_alpha: 'Hélice transmembrana α', tm_beta: 'Lámina transmembrana β', signal_peptide: 'Péptido señal',
  very_high_confidence: 'Confianza muy alta', confident: 'Confiable', low_confidence: 'Confianza baja', very_low_confidence: 'Confianza muy baja', missing: 'Sin residuo', invalid_coordinates: 'Coordenadas inválidas', mismatch: 'Residuo no coincide', missing_confidence: 'Sin confianza disponible',
  aqueous_folded: 'Soluble plegado', structurally_uncertain: 'Estructura incierta', membrane: 'Membrana',
  helix: 'Hélice', sheet: 'Lámina β', turn: 'Giro', coil: 'Bucle / coil', buried: 'Enterrado', exposed: 'Expuesto',
  highly_frustrated: 'Altamente frustrado', neutral: 'Neutral', minimally_frustrated: 'Mínimamente frustrado',
  'LDL-receptor class A': 'Receptor LDL clase A', 'EGF-like': 'Tipo EGF', 'Beta-propeller': 'Propela β', 'C-terminal region': 'Región C-terminal',
  true: 'Sí', false: 'No', NA: 'Sin dato',
};

export const ANNOTATION_GROUPS = [
  ['Contexto funcional', [
    ['tag', 'Dominio UniProt', 'uniprot_domain'],
  ]],
  ['Estructura', [
    ['waves', 'Topología de membrana', 'tmbed_topology'],
    ['shield-check', 'Calidad del modelo', 'structure_qc_status'],
    ['layers-3', 'Régimen estructural', 'structural_regime'],
    ['route', 'Estructura secundaria', 'secondary_structure'],
    ['circle-dot', 'Exposición al solvente', 'buried_status'],
    ['zap', 'Energía por residuo', 'residue_energy_value'],
    ['activity', 'Índice de frustración', 'structural_frustration_fi_singleresidue'],
    ['network', 'Contactos estructurales', 'structural_contacts_n_contacts'],
  ]],
  ['Predicción y conservación', [
    ['chart-column', 'AlphaMissense', 'alphamissense_mean'],
    ['gauge', 'CADD PHRED', 'cadd_phred_mean'],
    ['chart-column', 'REVEL', 'revel_mean'],
    ['sparkles', 'Frustración por secuencia', 'frustraiseq_class'],
    ['scan-search', 'Conservación ConSurf', 'consurf_grade'],
  ]],
  ['Evidencia experimental', [
    ['flask-conical', 'Ensayado en MaveDB', 'mavedb_position_assayed'],
  ]],
];

export function residueKey(residue) {
  return `${residue.chain}|${residue.authSeqId}|${residue.insCode || ''}`;
}

export function oneLetter(compId) {
  return ONE_FROM_THREE[String(compId || '').toUpperCase()] ?? String(compId || '?').slice(0, 1);
}

export function canonicalChain(sequence) {
  const residues = [...String(sequence || '')].map((one, index) => ({
    chain: 'A',
    authSeqId: index + 1,
    insCode: '',
    compId: AA3[one] ?? 'UNK',
    one,
    // A synthetic sequence is useful for the textual fallback, but it is not
    // evidence of a canonical-to-structure mapping.
    aaPosition: null,
  }));
  return residues.length ? [{ id: 'A', residues }] : [];
}

function mappingResidueKey(chain, residueNumber, insertionCode = '') {
  return `${String(chain || 'A')}|${String(residueNumber)}|${String(insertionCode || '')}`;
}

export function assignCanonicalPositions(chains, canonicalSequence, structureMapping = null) {
  const canonicalLength = String(canonicalSequence || '').length;
  const pairs = Array.isArray(structureMapping?.canonical_to_structure)
    ? structureMapping.canonical_to_structure
    : [];
  const byStructureResidue = new Map();
  const usedCanonicalPositions = new Set();
  for (const pair of pairs) {
    const canonicalPosition = Number(pair?.canonical_position);
    const residueNumber = pair?.residue_number;
    if (!Number.isInteger(canonicalPosition) || canonicalPosition < 1 || canonicalPosition > canonicalLength) continue;
    if (residueNumber === null || residueNumber === undefined || residueNumber === '') continue;
    if (usedCanonicalPositions.has(canonicalPosition)) continue;
    const key = mappingResidueKey(pair?.chain, residueNumber, pair?.insertion_code);
    if (byStructureResidue.has(key)) continue;
    usedCanonicalPositions.add(canonicalPosition);
    byStructureResidue.set(key, {
      canonicalPosition,
      aminoAcid: String(pair?.aa ?? '').toUpperCase(),
    });
  }
  return chains.map((chain) => {
    return {
      ...chain,
      residues: chain.residues.map((residue) => ({
        ...residue,
        aaPosition: (() => {
          const mapped = byStructureResidue.get(mappingResidueKey(residue.chain, residue.authSeqId, residue.insCode));
          return mapped && (!mapped.aminoAcid || mapped.aminoAcid === residue.one) ? mapped.canonicalPosition : null;
        })(),
      })),
    };
  });
}

export function finiteAnnotationValue(value) {
  if (value === null || value === undefined || value === 'NA' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeValue(value, min, max) {
  const number = finiteAnnotationValue(value);
  if (number === null || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (number - min) / (max - min)));
}

function mixRgb(hexA, hexB, ratio) {
  const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const start = rgb(hexA);
  const end = rgb(hexB);
  const parts = start.map((channel, index) => Math.round(channel + (end[index] - channel) * ratio));
  return `#${parts.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function colorOnScale(t, [low, mid, high]) {
  if (t === null) return null;
  return t <= 0.5 ? mixRgb(low, mid, t * 2) : mixRgb(mid, high, (t - 0.5) * 2);
}

export function relativeDomain(mode, rows) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || spec.kind !== 'continuous') return null;
  const numbers = [];
  for (const row of rows ?? []) {
    const number = finiteAnnotationValue(row?.values?.[spec.field]);
    if (number !== null) numbers.push(number);
  }
  if (!numbers.length) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers), relative: true };
}

function hasPublishedField(rows, field, kind) {
  return (rows ?? []).some((row) => {
    if (!Number.isInteger(row?.aa_position) || row.aa_position < 1) return false;
    const value = row?.values?.[field];
    if (kind === 'continuous') return finiteAnnotationValue(value) !== null;
    return value !== null && value !== undefined && value !== '' && value !== 'NA';
  });
}

export function viewerModeAvailability(rows, { structureAvailable = false, mappingValid = false } = {}) {
  const mappedStructure = Boolean(structureAvailable && mappingValid);
  return {
    regime: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.regime.field, 'categorical'),
    frustration: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.frustration.field, 'continuous'),
    contacts: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.contacts.field, 'continuous'),
    conservation: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.conservation.field, 'continuous'),
  };
}

export function annotationForResidue(residue, byPosition) {
  if (residue?.aaPosition == null) return null;
  const row = byPosition.get(residue.aaPosition) ?? null;
  if (!row) return null;
  if (row.aa_ref && row.aa_ref !== 'NA' && residue.one && row.aa_ref !== residue.one) return null;
  return row;
}

export function colorForValues(mode, values, domain) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || !values) return null;
  if (spec.kind === 'categorical') {
    const category = values[spec.field];
    if (category === null || category === undefined || category === '' || category === 'NA') return null;
    return spec.colors[category] ?? null;
  }
  if (!domain) return null;
  return colorOnScale(normalizeValue(values[spec.field], domain.min, domain.max), spec.colors);
}

export function residueDisplayColor(mode, residue, row, domain) {
  return colorForValues(mode, row?.values, domain) ?? MISSING_COLOR;
}

export function hexToColorInt(hex) {
  return Number.parseInt(String(hex).slice(1), 16);
}

export function formatScaleNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

export function readableValue(key, value) {
  const text = String(value ?? 'NA');
  if (key === 'structural_contacts_n_contacts' && text !== 'NA') return `${text} contactos`;
  if (key === 'consurf_grade' && text !== 'NA') return `${text} / 9`;
  if (key === 'cadd_phred_mean' && text !== 'NA') return `${text} PHRED`;
  return VALUE_LABELS[text] || text;
}
