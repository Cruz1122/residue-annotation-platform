import { formatConservationGrade, normalizeConservationGrade } from './conservation-presentation.js';
import {
  classifyFrustrAISeqIndex,
  classifyFrustratometerValue,
  FRUSTRATION_CLASS_INFO,
  HIGHLY_FRUSTRATED_CUTOFF,
  normalizeFrustrationClass,
  SRFI_MINIMALLY_FRUSTRATED_CUTOFF,
} from './frustration-classification.js';
import { SCIENTIFIC_EVIDENCE_MODE_CONFIG } from './scientific-evidence-presentation.js';

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
  'scientific-evidence': {
    title: 'Evidencia científica',
    shortTitle: 'Evidencia científica',
    icon: 'route',
    mode: 'evidence-curated',
    stageIds: ['functional_region_evidence', 'uniprot_features', 'experimental_variant_evidence', 'pharmacogenomics', 'variant_predictors', 'clinvar'],
    primaryStageId: 'functional_region_evidence',
    description: 'Anotaciones de recursos, resultados experimentales, información clínica y predicciones computacionales publicadas para esta corrida.',
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
    classificationColors: {
      highly_frustrated: FRUSTRATION_CLASS_INFO.highly_frustrated.color,
      neutral: FRUSTRATION_CLASS_INFO.neutral.color,
      minimally_frustrated: FRUSTRATION_CLASS_INFO.minimally_frustrated.color,
      unknown: FRUSTRATION_CLASS_INFO.unknown.color,
    },
    // Kept for the comparison view, which still plots the raw ensemble mean continuously.
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
  ...SCIENTIFIC_EVIDENCE_MODE_CONFIG,
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

function formatFrustrationCutoff(value) {
  const formatted = Math.abs(value).toLocaleString('es-CO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `−${formatted}` : formatted;
}

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
  frustration: {
    title: 'Frustración por residuo',
    icon: 'activity',
    legend: [
      [`Alta · < ${formatFrustrationCutoff(HIGHLY_FRUSTRATED_CUTOFF)}`, FRUSTRATION_CLASS_INFO.highly_frustrated.color],
      [`Neutral · ${formatFrustrationCutoff(HIGHLY_FRUSTRATED_CUTOFF)} a ${formatFrustrationCutoff(SRFI_MINIMALLY_FRUSTRATED_CUTOFF)}`, FRUSTRATION_CLASS_INFO.neutral.color],
      [`Mínima · > ${formatFrustrationCutoff(SRFI_MINIMALLY_FRUSTRATED_CUTOFF)}`, FRUSTRATION_CLASS_INFO.minimally_frustrated.color],
    ],
  },
  contacts: { title: 'Contactos estructurales', icon: 'network' },
  conservation: { title: 'Conservación evolutiva', icon: 'scan-search' },
  functional: {
    title: 'Evidencia científica',
    icon: 'route',
    legend: [
      ['Fuera de regiones LDL-C/estatinas', VISUALIZATION_MODES.functional.colors.false],
      ['Región UniProtKB/InterPro', VISUALIZATION_MODES.functional.colors.curated_region],
      ['Sitio anotado', VISUALIZATION_MODES.functional.colors.functional_interest],
      ['Péptido o segmento procesado', VISUALIZATION_MODES.functional.colors.highlighted_segment],
      ['Otra característica UniProtKB', VISUALIZATION_MODES.functional.colors.annotation],
      ['Sin dato', VISUALIZATION_MODES.functional.colors.unknown],
    ],
  },
  ...Object.fromEntries(Object.entries(SCIENTIFIC_EVIDENCE_MODE_CONFIG).map(([mode, config]) => [mode, {
    title: config.title,
    icon: config.icon,
    legend: config.legend,
  }])),
  ddg: { title: 'ΔΔG de variante', icon: 'zap' },
};

const VALUE_LABELS = {
  outside: 'Exterior', inside: 'Interior', tm_alpha: 'Hélice transmembrana α', tm_beta: 'Lámina transmembrana β', signal_peptide: 'Péptido señal',
  missing: 'Sin residuo', invalid_coordinates: 'Coordenadas inválidas', mismatch: 'Residuo no coincide',
  aqueous_folded: 'Soluble plegado', structurally_uncertain: 'Estructura incierta', membrane: 'Membrana',
  helix: 'Hélice', sheet: 'Lámina β', turn: 'Giro', coil: 'Bucle / coil', buried: 'Enterrado', exposed: 'Expuesto',
  highly_frustrated: 'Altamente frustrado', neutral: 'Neutral', minimally_frustrated: 'Mínimamente frustrado',
  true: 'Sí', false: 'No', exact: 'Exacto', not_in_reference: 'Fuera de la referencia',
  ok: 'Válido', success: 'Completado', failed: 'Fallido', skipped: 'Omitido', NA: 'Sin dato',
  reliable: 'Fiable',
  tmbed_only: 'Solo TMbed', uniprot_only: 'Solo UniProt', concordant: 'Concordante',
  discordant: 'Discordante', both: 'Concordante',
  curated_region: 'Región UniProtKB/InterPro', functional_interest: 'Sitio anotado',
  highlighted_segment: 'Péptido o segmento procesado', annotation: 'Otra característica UniProtKB',
};

// UniProt feature types use a controlled vocabulary. Feature names can be
// protein-specific, so normalize common scientific phrases while preserving
// unrecognized names and accessions verbatim.
const UNIPROT_FEATURE_TYPE_LABELS = Object.freeze({
  signal: 'Péptido señal',
  'signal peptide': 'Péptido señal',
  'transit peptide': 'Péptido de tránsito',
  propeptide: 'Propéptido',
  peptide: 'Péptido',
  chain: 'Cadena',
  'alternative sequence': 'Secuencia alternativa',
  'alternative initiation': 'Inicio alternativo',
  family: 'Familia proteica',
  region: 'Región',
  domain: 'Dominio',
  repeat: 'Repetición',
  'coiled-coil': 'Hélice superenrollada',
  'coiled coil': 'Hélice superenrollada',
  motif: 'Motivo',
  'short sequence motif': 'Motivo de secuencia corta',
  'compositional bias': 'Sesgo composicional',
  'compositionally biased region': 'Región de sesgo composicional',
  transmembrane: 'Región transmembrana',
  'transmembrane helix': 'Hélice transmembrana',
  intramembrane: 'Región intramembrana',
  'topological domain': 'Dominio topológico',
  'binding site': 'Sitio de unión',
  'active site': 'Sitio activo',
  'metal binding': 'Unión a metal',
  'metal ion binding': 'Unión a ion metálico',
  'nucleotide binding': 'Unión a nucleótido',
  'nucleotide phosphate binding': 'Unión a nucleótido fosfato',
  'dna binding': 'Unión a ADN',
  'rna binding': 'Unión a ARN',
  'calcium binding': 'Unión a calcio',
  'disulfide bond': 'Puente disulfuro',
  'cross-link': 'Enlace cruzado',
  crosslink: 'Enlace cruzado',
  glycosylation: 'Glicosilación',
  'glycosylation site': 'Sitio de glicosilación',
  lipidation: 'Lipidación',
  'modified residue': 'Residuo modificado',
  'natural variant': 'Variante natural',
  'natural variation': 'Variación natural',
  mutagenesis: 'Mutagénesis',
  'mutagenesis site': 'Sitio de mutagénesis',
  'sequence conflict': 'Conflicto de secuencia',
  'sequence uncertainty': 'Incertidumbre de secuencia',
  'unsure residue': 'Residuo de secuencia incierta',
  'non-adjacent residues': 'Residuos no consecutivos',
  'non-consecutive residues': 'Residuos no consecutivos',
  'non-terminal residue': 'Residuo no terminal',
  'non-standard residue': 'Residuo no canónico',
  helix: 'Hélice',
  'beta strand': 'Lámina β',
  strand: 'Hebra β',
  turn: 'Giro',
  'initiator methionine': 'Metionina iniciadora',
  'zinc finger': 'Dedo de zinc',
  'rna editing': 'Edición de ARN',
  frameshift: 'Desplazamiento del marco de lectura',
});

const UNIPROT_FEATURE_PHRASES = [
  [/\bLDL[-\s]+receptor\s+class\s+A\b/gi, 'Receptor LDL clase A'],
  [/\bC-terminal\s+region\b/gi, 'Región C-terminal'],
  [/\bN-terminal\s+region\b/gi, 'Región N-terminal'],
  [/\bcompositionally\s+biased\s+region\b/gi, 'Región de sesgo composicional'],
  [/\btransmembrane\s+helix\b/gi, 'Hélice transmembrana'],
  [/\btransmembrane\s+region\b/gi, 'Región transmembrana'],
  [/\btopological\s+domain\b/gi, 'Dominio topológico'],
  [/\bnon[-\s]+adjacent\s+residues\b/gi, 'Residuos no consecutivos'],
  [/\bnon[-\s]+terminal\s+residue\b/gi, 'Residuo no terminal'],
  [/\bshort\s+sequence\s+motif\b/gi, 'Motivo de secuencia corta'],
  [/\bbinding\s+site\b/gi, 'Sitio de unión'],
  [/\bactive\s+site\b/gi, 'Sitio activo'],
  [/\bmetal[-\s]+binding\b/gi, 'Unión a metal'],
  [/\bmetal[-\s]+ion[-\s]+binding\b/gi, 'Unión a ion metálico'],
  [/\bnucleotide[-\s]+phosphate[-\s]+binding\b/gi, 'Unión a nucleótido fosfato'],
  [/\bnucleotide[-\s]+binding\b/gi, 'Unión a nucleótido'],
  [/\bDNA[-\s]+binding\b/gi, 'Unión a ADN'],
  [/\bRNA[-\s]+binding\b/gi, 'Unión a ARN'],
  [/\bcalcium[-\s]+binding\b/gi, 'Unión a calcio'],
  [/\bdisulfide\s+bond\b/gi, 'Puente disulfuro'],
  [/\bcross[-\s]+link\b/gi, 'Enlace cruzado'],
  [/\bglycosylation\s+site\b/gi, 'Sitio de glicosilación'],
  [/\bnon[-\s]+standard\s+residue\b/gi, 'Residuo no canónico'],
  [/\bsignal\s+peptide\b/gi, 'Péptido señal'],
  [/\btransit\s+peptide\b/gi, 'Péptido de tránsito'],
  [/\bapolipoprotein\b/gi, 'Apolipoproteína'],
  [/\bEGF-like\b/gi, 'Tipo EGF'],
  [/\b(?:beta|β)[-\s]+propeller\b/gi, 'Propela β'],
];

const CLINVAR_STATUS_LABELS = Object.freeze({
  no_matching_snv_in_local_vcf: 'Sin variantes coincidentes',
  matches_found: 'Variantes coincidentes',
  matched: 'Variantes coincidentes',
});

export function normalizeUniprotFeatureLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) return '';

  return label.split(/[·;|]/).map((part) => {
    const normalized = part.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (!normalized) return normalized;
    const key = normalized.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s*-\s*/g, '-');
    const featureTypeLabel = UNIPROT_FEATURE_TYPE_LABELS[key];
    if (featureTypeLabel) return featureTypeLabel;
    return UNIPROT_FEATURE_PHRASES.reduce((result, [pattern, translation]) => result.replace(pattern, translation), normalized);
  }).filter(Boolean).join(' · ');
}

export function clinvarStatusLabel(value) {
  const status = String(value ?? '').trim().toLowerCase();
  return CLINVAR_STATUS_LABELS[status] ?? null;
}

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

export function assignCanonicalPositions(chains, canonicalSequence, structureMapping = null, requestedVariants = []) {
  const canonicalLength = String(canonicalSequence || '').length;
  const canonicalResidues = String(canonicalSequence || '').toUpperCase();
  const alternateByPosition = new Map((requestedVariants ?? []).flatMap((variant) => {
    const position = Number(variant?.aa_position);
    const reference = String(variant?.aa_ref ?? '').trim().toUpperCase();
    const alternate = String(variant?.aa_alt ?? '').trim().toUpperCase();
    if (!Number.isInteger(position) || position < 1 || position > canonicalLength || !/^[A-Z]$/.test(alternate)) return [];
    if (reference && canonicalResidues[position - 1] !== reference) return [];
    return [[position, alternate]];
  }));
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
          const normalizedResidue = String(residue.one ?? '').toUpperCase();
          const expectedAlternate = alternateByPosition.get(mapped?.canonicalPosition);
          const isRequestedAlternate = expectedAlternate === normalizedResidue
            && (!mapped?.aminoAcid || mapped.aminoAcid === canonicalResidues[mapped.canonicalPosition - 1]);
          return mapped && (!mapped.aminoAcid || mapped.aminoAcid === normalizedResidue || isRequestedAlternate)
            ? mapped.canonicalPosition
            : null;
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

export function mergeAnnotationRows(rows, requestedVariants = []) {
  const byPosition = new Map();
  const variantsByPosition = new Map((requestedVariants ?? []).map((variant) => [
    Number(variant?.aa_position),
    {
      aaRef: String(variant?.aa_ref ?? '').toUpperCase(),
      aaAlt: String(variant?.aa_alt ?? '').toUpperCase(),
    },
  ]));
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
    if (current.aa_ref && row.aa_ref && current.aa_ref !== row.aa_ref) {
      const variant = variantsByPosition.get(row.aa_position);
      const isRequestedSubstitution = variant
        && ((current.aa_ref === variant.aaRef && row.aa_ref === variant.aaAlt)
          || (row.aa_ref === variant.aaRef && current.aa_ref === variant.aaAlt));
      if (!isRequestedSubstitution) continue;
    }
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

export function viewerModeAvailability(rows, { structureAvailable = false, mappingValid = false, allowSequenceOnly = false } = {}) {
  const mappedStructure = Boolean(structureAvailable && mappingValid);
  const viewable = mappedStructure || allowSequenceOnly;
  return {
    topology: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.topology.field, 'categorical'),
    regime: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.regime.field, 'categorical'),
    frustration: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.frustration.field, 'continuous', VISUALIZATION_MODES.frustration.fallbackFields),
    contacts: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.contacts.field, 'continuous'),
    conservation: viewable && (rows ?? []).some((row) => normalizeConservationGrade(row?.values?.consurf_grade) !== null),
    functional: viewable && (
      hasPublishedField(rows, VISUALIZATION_MODES.functional.field, 'categorical')
      || hasPublishedField(rows, 'functional_feature_class', 'categorical')
    ),
    ...Object.fromEntries(Object.entries(SCIENTIFIC_EVIDENCE_MODE_CONFIG).map(([mode, config]) => [
      mode,
      viewable && hasPublishedField(rows, config.field, 'categorical'),
    ])),
    ddg: mappedStructure && hasPublishedField(rows, VISUALIZATION_MODES.ddg.field, 'continuous'),
  };
}

export function annotationForResidue(residue, byPosition, requestedVariants = []) {
  const position = residue?.aaPosition ?? residue?.canonicalPosition;
  if (position == null) return null;
  const row = byPosition.get(position) ?? null;
  if (!row) return null;
  if (row.aa_ref && row.aa_ref !== 'NA' && residue.one && row.aa_ref !== residue.one) {
    const variant = (requestedVariants ?? []).find((item) => Number(item?.aa_position) === position);
    const matchesRequestedSubstitution = variant
      && String(variant.aa_ref ?? '').toUpperCase() === String(row.aa_ref).toUpperCase()
      && String(variant.aa_alt ?? '').toUpperCase() === String(residue.one).toUpperCase();
    if (!matchesRequestedSubstitution) return null;
  }
  return row;
}

function frustrationClassification(values) {
  const measurement = measurementForMode('frustration', values);
  if (!measurement) return null;
  if (measurement.field === 'frustraiseq_index') {
    const publishedClass = normalizeFrustrationClass(values.frustraiseq_class);
    return publishedClass === 'unknown' ? classifyFrustrAISeqIndex(measurement.value) : publishedClass;
  }
  return classifyFrustratometerValue(
    measurement.value,
    measurement.field === 'frustratometer_mean'
      ? 'structural_frustration_fi_singleresidue'
      : measurement.field,
  );
}

export function colorForValues(mode, values, domain) {
  const spec = VISUALIZATION_MODES[mode];
  if (!spec || !values) return null;
  if (mode === 'frustration') {
    const category = frustrationClassification(values);
    if (!category) return null;
    return spec.classificationColors[category] ?? null;
  }
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
  if (key === 'uniprot_domain') return normalizeUniprotFeatureLabel(text);
  return VALUE_LABELS[text] || VALUE_LABELS[text.toLowerCase()] || text;
}
