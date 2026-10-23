import { formatConservationGrade, normalizeConservationGrade } from './conservation-presentation.js';

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

export const ANALYSIS_VIEWS = {
  topology: {
    title: 'Topología de membrana',
    shortTitle: 'Topología',
    icon: 'waves',
    mode: 'topology',
    stageIds: ['membrane_topology', 'structural_regime', 'uniprot_features'],
    primaryStageId: 'membrane_topology',
    description: 'Clasificación topológica publicada por TMbed, normalizada para visualización.',
  },
  frustration: {
    title: 'Frustración por residuo',
    shortTitle: 'Frustración',
    icon: 'activity',
    mode: 'frustration',
    stageIds: ['ensemble_frustration', 'structural_frustration', 'sequence_frustration', 'conformational_ensemble', 'physicochemical_context'],
    primaryStageId: 'ensemble_frustration',
    description: 'Frustración por residuo; prioriza el ensemble y usa una fuente estructural o secuencial publicada cuando la corrida no incluye conformeros.',
  },
  conservation: {
    title: 'Conservación evolutiva',
    shortTitle: 'Conservación evolutiva',
    icon: 'scan-search',
    mode: 'conservation',
    stageIds: ['evolutionary_conservation', 'uniprot_features'],
    primaryStageId: 'evolutionary_conservation',
    description: 'Puntajes Rate4Site y grados ConSurf publicados para la secuencia canónica.',
  },
  functional: {
    title: 'Regiones funcionales',
    shortTitle: 'Región funcional',
    icon: 'route',
    mode: 'functional',
    stageIds: ['functional_region_evidence', 'uniprot_features'],
    primaryStageId: 'functional_region_evidence',
    description: 'Evidencia curada de pertenencia a regiones funcionales y estado del mapeo canónico.',
  },
  ddg: {
    title: 'ΔΔG de variante',
    shortTitle: 'ΔΔG',
    icon: 'zap',
    mode: 'ddg',
    stageIds: ['variant_ddg', 'protein_relaxation_energy'],
    primaryStageId: 'variant_ddg',
    description: 'Evaluaciones de variantes solicitadas y sus resultados publicados.',
  },
  contacts: {
    title: 'Contactos estructurales',
    shortTitle: 'Contactos',
    icon: 'network',
    mode: 'contacts',
    stageIds: ['structural_contacts', 'protein_relaxation_energy'],
    primaryStageId: 'structural_contacts',
    description: 'Conteos y tipos de contacto ARPEGGIO en la estructura de referencia.',
  },
};

// Presentation tokens. Continuous scales use fixed, documented reference
// domains. A domain must never be derived from the minimum/maximum of the
// current protein: doing that would make the same scientific value change
// colour between proteins and would turn a low value into a false midpoint.
export const VISUALIZATION_MODES = {
  topology: {
    kind: 'categorical',
    field: 'tmbed_topology',
    colors: {
      unknown: '#b8bec5',
      aqueous: '#3aa6b9',
      transmembrane: '#e4674f',
      signal_peptide: '#dfb62f',
    },
  },
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
    field: 'frustratometer_mean',
    fallbackFields: ['structural_frustration_fi_singleresidue', 'frustraiseq_index'],
    colors: ['#0759c7', '#00a8c6', '#b8dc16', '#ff9d00', '#c90000'],
  },
  contacts: {
    kind: 'continuous',
    field: 'structural_contacts_n_contacts',
    colors: ['#2aab71', '#e68a36', '#8745c4'],
  },
  conservation: {
    kind: 'continuous',
    // ConSurf is the only conservation field with a shared native 1--9
    // scale. Rate4Site is still displayed in the details panel, but it is
    // not mixed into this colour scale because it has a different unit/range.
    field: 'consurf_grade',
    colors: ['#fff19b', '#27c690', '#08a8c8', '#3764dc', '#5b00a5'],
  },
  functional: {
    kind: 'categorical',
    field: 'variant_in_statin_ldlc_region',
    colors: {
      true: '#35bd72',
      false: '#c3c7cb',
      curated_region: '#35bd72',
      functional_interest: '#27a8b5',
      highlighted_segment: '#ee805b',
      annotation: '#8a63d2',
      unknown: '#e7e8e8',
    },
  },
  ddg: {
    kind: 'continuous',
    field: 'ddg_value',
    colors: ['#1769c2', '#e7ecef', '#e4572e'],
  },
};

export const MODE_SCALE_COPY = {
  frustration: {
    magnitude: 'Índice de frustración',
    note: 'Valor por residuo',
  },
  contacts: {
    magnitude: 'Contactos por residuo',
    note: 'Conteo absoluto',
  },
  conservation: {
    magnitude: 'Grado ConSurf',
    note: 'Escala ordinal nativa 1–9',
  },
  ddg: {
    magnitude: 'ΔΔG de la variante',
    note: 'Unidad del artefacto',
  },
};

// These are visual reference domains, not biological cut-offs. The raw value
// shown beside a residue is never changed; only its position in the colour
// ramp is clamped when it falls outside the documented reference range.
export const FIXED_NUMERIC_DOMAINS = {
  frustration: { min: -2, max: 2, source: 'frustratometer_reference' },
  contacts: { min: 0, max: 50, source: 'absolute_contact_count_reference' },
  conservation: { min: 1, max: 9, source: 'consurf_native_grade' },
  ddg: { min: -5, max: 5, source: 'fixed_native_unit_reference' },
};

export const MODE_INFO = {
  topology: {
    title: 'Topología de membrana',
    icon: 'waves',
    legend: [
      ['Desconocida', VISUALIZATION_MODES.topology.colors.unknown],
      ['Acuosa', VISUALIZATION_MODES.topology.colors.aqueous],
      ['Transmembrana', VISUALIZATION_MODES.topology.colors.transmembrane],
      ['Péptido señal', VISUALIZATION_MODES.topology.colors.signal_peptide],
    ],
  },
  regime: {
    title: 'Régimen estructural',
    icon: 'layers-3',
    legend: [
      ['Membrana', VISUALIZATION_MODES.regime.colors.membrane],
      ['Soluble plegado', VISUALIZATION_MODES.regime.colors.aqueous_folded],
      ['Estructura incierta', VISUALIZATION_MODES.regime.colors.structurally_uncertain],
    ],
  },
  frustration: { title: 'Frustración por residuo', icon: 'activity' },
  contacts: { title: 'Contactos estructurales', icon: 'network' },
  conservation: { title: 'Conservación evolutiva', icon: 'scan-search' },
  functional: {
    title: 'Evidencia de región funcional',
    icon: 'route',
    legend: [
      ['Sin evidencia en el recurso', VISUALIZATION_MODES.functional.colors.false],
      ['Región funcional curada', VISUALIZATION_MODES.functional.colors.curated_region],
      ['Región de interés funcional', VISUALIZATION_MODES.functional.colors.functional_interest],
      ['Segmento funcional destacado', VISUALIZATION_MODES.functional.colors.highlighted_segment],
      ['Anotación UniProt', VISUALIZATION_MODES.functional.colors.annotation],
      ['Sin dato', VISUALIZATION_MODES.functional.colors.unknown],
    ],
  },
  ddg: { title: 'ΔΔG de variante', icon: 'zap' },
};

const VALUE_LABELS = {
  outside: 'Exterior', inside: 'Interior', tm_alpha: 'Hélice transmembrana α', tm_beta: 'Lámina transmembrana β', signal_peptide: 'Péptido señal',
  missing: 'Sin residuo', invalid_coordinates: 'Coordenadas inválidas', mismatch: 'Residuo no coincide',
  aqueous_folded: 'Soluble plegado', structurally_uncertain: 'Estructura incierta', membrane: 'Membrana',
  helix: 'Hélice', sheet: 'Lámina β', turn: 'Giro', coil: 'Bucle / coil', buried: 'Enterrado', exposed: 'Expuesto',
  highly_frustrated: 'Altamente frustrado', neutral: 'Neutral', minimally_frustrated: 'Mínimamente frustrado',
  'LDL-receptor class A': 'Receptor LDL clase A', 'EGF-like': 'Tipo EGF', 'Beta-propeller': 'Propela β', 'C-terminal region': 'Región C-terminal',
  true: 'Sí', false: 'No', exact: 'Exacto', not_in_reference: 'Fuera de la referencia',
  ok: 'Válido', success: 'Completado', failed: 'Fallido', skipped: 'Omitido', NA: 'Sin dato',
  reliable: 'Fiable',
  tmbed_only: 'Solo TMbed', uniprot_only: 'Solo UniProt', concordant: 'Concordante',
  discordant: 'Discordante', both: 'Concordante',
  curated_region: 'Región funcional curada', functional_interest: 'Región de interés funcional',
  highlighted_segment: 'Segmento funcional destacado', annotation: 'Anotación UniProt',
};

export const ANNOTATION_GROUPS = [
  ['Contexto funcional', [
    ['tag', 'Dominio UniProt', 'uniprot_domain'],
  ]],
  ['Estructura', [
    ['waves', 'Topología de membrana', 'tmbed_topology'],
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
    canonicalPosition: index + 1,
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

/**
 * Return the first numeric value published for a visualization mode.
 *
 * A mode can have a primary field and explicitly ordered fallbacks. This is
 * important for real runs where an optional analysis (for example the BioEmu
 * ensemble) was not produced, but a structurally or sequence-derived value
 * is still available. The caller can inspect `field` to keep provenance clear.
 */
export function measurementForMode(mode, values) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || spec.kind !== 'continuous' || !values) return null;
  if (mode === 'conservation') {
    const grade = normalizeConservationGrade(values[spec.field]);
    return grade === null ? null : { field: spec.field, value: grade };
  }
  const fields = [spec.field, ...(spec.fallbackFields ?? [])];
  for (const field of fields) {
    const value = finiteAnnotationValue(values[field]);
    if (value !== null) return { field, value };
  }
  return null;
}

export function publishedModeValue(mode, values) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || !values) return null;
  if (spec.kind === 'continuous') return measurementForMode(mode, values);
  const field = mode === 'functional' && values.functional_feature_class
    ? 'functional_feature_class'
    : spec.field;
  const value = values[field];
  if (value === null || value === undefined || value === '' || value === 'NA') return null;
  return { field, value };
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

export function colorOnScale(t, colors) {
  if (t === null) return null;
  if (colors.length < 2) return colors[0] ?? null;
  const scaled = Math.max(0, Math.min(1, t)) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  return mixRgb(colors[index], colors[index + 1], scaled - index);
}

export function topologyClass(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'inside' || normalized === 'outside' || normalized === 'aqueous') return 'aqueous';
  if (normalized === 'tm_alpha' || normalized === 'tm_beta' || normalized === 'transmembrane') return 'transmembrane';
  if (normalized === 'signal_peptide') return 'signal_peptide';
  return 'unknown';
}

export function booleanClass(value) {
  if (value === true || String(value).toLowerCase() === 'true') return 'true';
  if (value === false || String(value).toLowerCase() === 'false') return 'false';
  return 'unknown';
}

export function mergeAnnotationRows(rows) {
  const byPosition = new Map();
  for (const row of rows ?? []) {
    if (!Number.isInteger(row?.aa_position) || row.aa_position < 1) continue;
    const current = byPosition.get(row.aa_position) ?? {
      aa_position: row.aa_position,
      aa_ref: row.aa_ref,
      values: {},
      units: {},
      qcByStage: {},
      stages: [],
    };
    if (current.aa_ref && row.aa_ref && current.aa_ref !== row.aa_ref) continue;
    Object.assign(current.values, row.values ?? {});
    Object.assign(current.units, row.units ?? {});
    if (row.stage_id && row.qc_status !== null && row.qc_status !== undefined) current.qcByStage[row.stage_id] = row.qc_status;
    if (row.stage_id && !current.stages.includes(row.stage_id)) current.stages.push(row.stage_id);
    byPosition.set(row.aa_position, current);
  }
  return byPosition;
}

/**
 * Return the fixed reference domain used by the viewer colour ramp.
 *
 * `rows` is accepted so callers can keep a uniform memoized call signature,
 * but it is intentionally not inspected. This is the important distinction
 * from the old `relativeDomain` helper: data in the current protein must not
 * redefine the meaning of a colour.
 */
export function fixedDomainForMode(mode) {
  const domain = FIXED_NUMERIC_DOMAINS[mode];
  return domain ? { ...domain, relative: false } : null;
}

/**
 * Legacy helper kept for consumers that still need to inspect a run-local
 * range. It is not used by the viewer and must not be used for colouring.
 */
export function relativeDomain(mode, rows) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || spec.kind !== 'continuous') return null;
  const numbers = [];
  for (const row of rows ?? []) {
    const measurement = measurementForMode(mode, row?.values);
    if (measurement) numbers.push(measurement.value);
  }
  if (!numbers.length) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers), relative: true };
}

function hasPublishedField(rows, field, kind, fallbackFields = []) {
  return (rows ?? []).some((row) => {
    if (!Number.isInteger(row?.aa_position) || row.aa_position < 1) return false;
    if (kind === 'continuous') {
      return [field, ...fallbackFields].some((candidate) => finiteAnnotationValue(row?.values?.[candidate]) !== null);
    }
    const value = row?.values?.[field];
    return value !== null && value !== undefined && value !== '' && value !== 'NA';
  });
}

export function viewerModeAvailability(rows, { structureAvailable = false, mappingValid = false } = {}) {
  const mappedStructure = Boolean(structureAvailable && mappingValid);
  return {
    topology: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.topology.field, 'categorical'),
    regime: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.regime.field, 'categorical'),
    frustration: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.frustration.field, 'continuous', VISUALIZATION_MODES.frustration.fallbackFields),
    contacts: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.contacts.field, 'continuous'),
    conservation: mappedStructure && (rows ?? []).some((row) => normalizeConservationGrade(row?.values?.consurf_grade) !== null),
    functional: mappedStructure && (
      hasPublishedField(rows, VISUALIZATION_MODES.functional.field, 'categorical')
      || hasPublishedField(rows, 'functional_feature_class', 'categorical')
    ),
    ddg: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.ddg.field, 'continuous'),
  };
}

export function annotationForResidue(residue, byPosition) {
  const position = residue?.aaPosition ?? residue?.canonicalPosition;
  if (position == null) return null;
  const row = byPosition.get(position) ?? null;
  if (!row) return null;
  if (row.aa_ref && row.aa_ref !== 'NA' && residue.one && row.aa_ref !== residue.one) return null;
  return row;
}

export function colorForValues(mode, values, domain) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || !values) return null;
  if (spec.kind === 'categorical') {
    let category = mode === 'functional' && values.functional_feature_class
      ? values.functional_feature_class
      : values[spec.field];
    if (category === null || category === undefined || category === '' || category === 'NA') return null;
    if (mode === 'topology') category = topologyClass(category);
    if (mode === 'functional') {
      const featureClasses = String(values.functional_feature_class ?? '').split('|');
      const featureClass = ['highlighted_segment', 'functional_interest', 'curated_region', 'annotation']
        .find((candidate) => featureClasses.includes(candidate));
      category = featureClass || booleanClass(category);
    }
    if (mode === 'ddg') category = booleanClass(category);
    return spec.colors[category] ?? null;
  }
  if (!domain) return null;
  const measurement = measurementForMode(mode, values);
  return colorOnScale(normalizeValue(measurement?.value, domain.min, domain.max), spec.colors);
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
  if (key === 'consurf_grade') return formatConservationGrade(value);
  if (key === 'cadd_phred_mean' && text !== 'NA') return `${text} PHRED`;
  return VALUE_LABELS[text] || VALUE_LABELS[text.toLowerCase()] || text;
}
