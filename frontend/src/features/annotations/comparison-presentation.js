import {
  CONSERVATION_REFERENCE_URL,
  CONSERVATION_SCALE,
  RATE4SITE_REFERENCE_URL,
  normalizeConservationGrade,
} from './conservation-presentation.js';
import {
  ARPEGGIO_REFERENCE_URL,
  ARPEGGIO_SCALE_COLORS,
  buildArpeggioModel,
  buildArpeggioSummaryRows,
  contactTypeLabel,
} from './arpeggio-presentation.js';
import {
  colorForFrustrationMetric,
  FRUSTRATION_CLASS_INFO,
  FRUSTRAISEQ_ENTROPY_COLORS,
  FRUSTRAISEQ_ENTROPY_DOMAIN,
  FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF,
  FRUSTRAISEQ_SURPRISAL_COLORS,
  FRUSTRAISEQ_SURPRISAL_DOMAIN,
  HIGHLY_FRUSTRATED_CUTOFF,
  classifyFrustrAISeqIndex,
  classifyFrustratometerValue,
  frustrationClassLabel,
  minimallyFrustratedCutoff,
  normalizeFrustrationClass,
} from './frustration-presentation.js';
import { TOPOLOGY_CLASSES, normalizeTopologyClass } from './topology-presentation.js';
import {
  VISUALIZATION_MODES,
  colorOnScale,
  finiteAnnotationValue,
  fixedDomainForMode,
  formatScaleNumber,
  mergeAnnotationRows,
  normalizeValue,
} from './viewer-presentation.js';

export const COMPARISON_MISSING_COLOR = '#d7dcdf';
export const COMPARISON_ANALYSIS_ORDER = ['conservation', 'topology', 'ddg', 'arpeggio', 'frustration'];

const TMBED_REFERENCE_URL = 'https://doi.org/10.1186/s12859-022-04873-x';
const FRUSTRATOMETER_REFERENCE_URL = 'https://doi.org/10.1073/pnas.1614896113';
const FRUSTRAISEQ_REFERENCE_URL = 'https://doi.org/10.64898/2026.02.03.703498';

const FRUSTRATION_FIELDS = [
  { field: 'frustratometer_mean', label: 'Promedio del ensemble', source: 'FrustratometeR · ensemble', kind: 'frustratometer' },
  { field: 'structural_frustration_fi_singleresidue', label: 'Residuo individual (SRFI)', source: 'FrustratometeR', kind: 'frustratometer' },
  { field: 'structural_frustration_fi_configurational', label: 'Configuracional (FI)', source: 'FrustratometeR', kind: 'frustratometer' },
  { field: 'structural_frustration_fi_mutational', label: 'Mutacional (FI)', source: 'FrustratometeR', kind: 'frustratometer' },
  { field: 'frustraiseq_index', label: 'Índice', source: 'FrustrAI-Seq', kind: 'frustraiseq' },
  { field: 'frustraiseq_entropy', label: 'Entropía', source: 'FrustrAI-Seq', kind: 'frustraiseq' },
  { field: 'frustraiseq_surprisal', label: 'Surprisal', source: 'FrustrAI-Seq', kind: 'frustraiseq' },
];

export const COMPARISON_ANALYSES = {
  conservation: { id: 'conservation', label: 'Conservación evolutiva', source: 'ConSurf / Rate4Site', icon: 'scan-search' },
  topology: { id: 'topology', label: 'Topología de membrana', source: 'TMbed', icon: 'waves' },
  ddg: { id: 'ddg', label: 'ΔΔG de variante', source: 'Artefacto de la corrida', icon: 'zap' },
  arpeggio: { id: 'arpeggio', label: 'ARPEGGIO', source: 'PDBe Arpeggio', icon: 'network' },
  frustration: { id: 'frustration', label: 'Frustración', source: 'FrustratometeR / FrustrAI-Seq', icon: 'activity' },
};

function present(value) {
  return value !== null && value !== undefined && value !== '' && String(value).trim().toUpperCase() !== 'NA';
}

function recordPosition(record) {
  for (const key of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const value = Number(record?.[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  const variant = String(record?.variant_id ?? record?.variant ?? '').trim();
  const match = variant.match(/^[A-Z]?(\d+)[A-Z]?$/i);
  return match ? Number(match[1]) : null;
}

function genericArtifactRows(records, stageId) {
  return (records ?? []).flatMap((record) => {
    const position = recordPosition(record);
    if (!position) return [];
    const values = Object.fromEntries(Object.entries(record).filter(([key, value]) => (
      !['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number', 'aa_ref'].includes(key)
      && present(value)
    )));
    return [{ aa_position: position, aa_ref: record?.aa_ref, stage_id: stageId, values, units: record?.units ?? {} }];
  });
}

function numericDomain(values, { includeZero = false, symmetric = false } = {}) {
  const numbers = values.map(finiteAnnotationValue).filter((value) => value !== null);
  if (!numbers.length) return null;
  if (symmetric) {
    const extent = Math.max(...numbers.map(Math.abs), Number.EPSILON);
    return { min: -extent, max: extent, observedMin: Math.min(...numbers), observedMax: Math.max(...numbers), center: 0 };
  }
  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (includeZero) min = Math.min(0, min);
  if (min === max) max = min + (min === 0 ? 1 : Math.abs(min) * 0.01 || 1);
  return { min, max, observedMin: Math.min(...numbers), observedMax: Math.max(...numbers) };
}

function formatValue(value, unit = null, { signed = false } = {}) {
  const number = finiteAnnotationValue(value);
  if (number === null) return String(value ?? 'Sin dato publicado');
  const prefix = signed && number > 0 ? '+' : '';
  const text = `${prefix}${formatScaleNumber(number)}`;
  return unit ? `${text} ${unit}` : text;
}

function unitFor(row, field) {
  const value = row?.units?.[field];
  return present(value) ? String(value) : null;
}

function annotationRows(annotations, detailsByAnalysis) {
  const conservation = genericArtifactRows(detailsByAnalysis?.conservation?.evolution_per_residue, 'evolutionary_conservation_artifact');
  const topology = genericArtifactRows(detailsByAnalysis?.topology?.tmbed_per_residue, 'membrane_topology_artifact');
  const frustration = [
    ...genericArtifactRows(detailsByAnalysis?.frustration?.frustratometer_per_residue, 'ensemble_frustration_artifact'),
    ...genericArtifactRows(detailsByAnalysis?.frustration?.frustration_per_residue, 'structural_frustration_artifact'),
    ...genericArtifactRows(detailsByAnalysis?.frustration?.frustraiseq_per_residue, 'sequence_frustration_artifact'),
  ];
  // API annotations remain authoritative when both sources publish the same field.
  return mergeAnnotationRows([...conservation, ...topology, ...frustration, ...(annotations ?? [])]);
}

function ddgRecords(detailsByAnalysis, annotations) {
  const records = detailsByAnalysis?.ddg?.variant_annotations ?? [];
  if (records.length) return records;
  return (annotations ?? []).filter((row) => finiteAnnotationValue(row?.values?.ddg_value) !== null).map((row) => ({
    aa_position: row.aa_position,
    aa_ref: row.aa_ref,
    ddg_value: row.values.ddg_value,
    ddg_unit: row.units?.ddg_value,
  }));
}

function ddgUnit(record, detailsByAnalysis) {
  for (const value of [record?.ddg_unit, record?.unit, record?.units?.ddg_value, record?.units?.ddg]) {
    if (present(value)) return String(value);
  }
  for (const provenance of [
    ...(detailsByAnalysis?.ddg?.provenance ?? []),
    ...(detailsByAnalysis?.ddg?.rosetta_metadata ?? []),
  ]) {
    for (const value of [provenance?.ddg_unit, provenance?.unit, provenance?.units?.ddg_value, provenance?.units?.ddg]) {
      if (present(value)) return String(value);
    }
  }
  return null;
}

function ddgValue(record) {
  for (const key of ['ddg_value', 'ddg', 'energy_difference']) {
    const value = finiteAnnotationValue(record?.[key] ?? record?.values?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function conservationEntry(sequence, byPosition) {
  const grades = [...byPosition.values()].map((row) => normalizeConservationGrade(row?.values?.consurf_grade)).filter((value) => value !== null);
  const useConSurf = grades.length > 0;
  const field = useConSurf ? 'consurf_grade' : 'rate4site_score';
  const values = [...byPosition.values()].map((row) => finiteAnnotationValue(row?.values?.[field])).filter((value) => value !== null);
  if (!values.length) return null;
  const domain = useConSurf ? { min: 1, max: 9, observedMin: Math.min(...grades), observedMax: Math.max(...grades) } : numericDomain(values);
  const fieldUnits = [...new Set([...byPosition.values()].map((row) => unitFor(row, field)).filter(Boolean))];
  const fieldUnit = fieldUnits.length === 1 ? fieldUnits[0] : null;
  const colors = useConSurf ? VISUALIZATION_MODES.conservation.colors : [...VISUALIZATION_MODES.conservation.colors].reverse();
  const residues = new Map();
  for (let position = 1; position <= sequence.length; position += 1) {
    const row = byPosition.get(position);
    const raw = useConSurf ? normalizeConservationGrade(row?.values?.[field]) : finiteAnnotationValue(row?.values?.[field]);
    if (raw === null) continue;
    residues.set(position, {
      value: raw,
      color: colorOnScale(normalizeValue(raw, domain.min, domain.max), colors),
      rows: [{ label: useConSurf ? 'Grado ConSurf' : 'Puntuación Rate4Site', value: useConSurf ? `${raw} / 9` : formatValue(raw, unitFor(row, field)) }],
    });
  }
  return {
    ...COMPARISON_ANALYSES.conservation,
    tracks: [{ id: field, label: useConSurf ? 'Grado ConSurf' : 'Rate4Site', colors, domain }],
    residues,
    legend: {
      kind: 'continuous', colors, domain,
      minLabel: useConSurf
        ? `${CONSERVATION_SCALE.min} · ${CONSERVATION_SCALE.lowLabel}`
        : `${formatValue(domain.observedMin, fieldUnit)} · Más conservado`,
      maxLabel: useConSurf
        ? `${CONSERVATION_SCALE.max} · ${CONSERVATION_SCALE.highLabel}`
        : `${formatValue(domain.observedMax, fieldUnit)} · Más variable`,
      sourceUrl: useConSurf ? CONSERVATION_REFERENCE_URL : RATE4SITE_REFERENCE_URL,
      sourceLabel: useConSurf ? 'ConSurf' : 'Rate4Site',
    },
  };
}

function topologyEntry(sequence, byPosition) {
  const residues = new Map();
  const classes = new Set();
  for (let position = 1; position <= sequence.length; position += 1) {
    const row = byPosition.get(position);
    const raw = row?.values?.tmbed_topology ?? row?.values?.tmbed_label;
    if (!present(raw)) continue;
    const topologyClass = normalizeTopologyClass(raw);
    if (topologyClass === 'unknown') continue;
    classes.add(topologyClass);
    residues.set(position, {
      value: topologyClass,
      color: TOPOLOGY_CLASSES[topologyClass].color,
      rows: [{ label: 'Clase TMbed', value: TOPOLOGY_CLASSES[topologyClass].label }],
    });
  }
  if (!residues.size) return null;
  const categories = ['tm_alpha', 'tm_beta', 'outside', 'inside', 'signal_peptide']
    .filter((key) => classes.has(key))
    .map((key) => ({ key, label: TOPOLOGY_CLASSES[key].label, color: TOPOLOGY_CLASSES[key].color }));
  return {
    ...COMPARISON_ANALYSES.topology,
    tracks: [{ id: 'tmbed_topology', label: 'Clase TMbed' }],
    residues,
    legend: { kind: 'categorical', categories, sourceUrl: TMBED_REFERENCE_URL, sourceLabel: 'TMbed' },
  };
}

function ddgEntry(detailsByAnalysis, annotations) {
  const records = ddgRecords(detailsByAnalysis, annotations).map((record) => ({ record, position: recordPosition(record), value: ddgValue(record) }))
    .filter(({ position, value }) => position && value !== null);
  if (!records.length) return null;
  const domain = numericDomain(records.map(({ value }) => value), { symmetric: true });
  const colors = VISUALIZATION_MODES.ddg.colors;
  const units = [...new Set(records.map(({ record }) => ddgUnit(record, detailsByAnalysis)).filter(Boolean))];
  const scaleUnit = units.length === 1 ? units[0] : null;
  const grouped = new Map();
  for (const item of records) {
    const values = grouped.get(item.position) ?? [];
    values.push(item);
    grouped.set(item.position, values);
  }
  const residues = new Map();
  for (const [position, items] of grouped) {
    const representative = items.length === 1 ? items[0] : null;
    const rows = items.map(({ record, value }) => {
      const variant = String(record?.variant_id ?? record?.variant ?? '').trim();
      return { label: variant || 'ΔΔG', value: formatValue(value, ddgUnit(record, detailsByAnalysis), { signed: true }) };
    });
    residues.set(position, {
      value: representative?.value ?? null,
      color: representative ? colorOnScale(normalizeValue(representative.value, domain.min, domain.max), colors) : COMPARISON_MISSING_COLOR,
      rows,
      note: items.length > 1 ? 'Se publicaron varias variantes en esta posición; no se combinan en un único valor.' : null,
    });
  }
  return {
    ...COMPARISON_ANALYSES.ddg,
    tracks: [{ id: 'ddg_value', label: 'ΔΔG', colors, domain }],
    residues,
    legend: {
      kind: 'continuous', colors, domain,
      minLabel: formatValue(domain.min, scaleUnit, { signed: true }),
      maxLabel: formatValue(domain.max, scaleUnit, { signed: true }),
      centerLabel: formatValue(0, scaleUnit),
      ...(units.length > 1 ? { unitNote: `Unidades publicadas sin conversión: ${units.join(', ')}.` } : {}),
    },
  };
}

function arpeggioEntry(sequence, detailsByAnalysis, annotations) {
  const annotationByPosition = mergeAnnotationRows(annotations ?? []);
  const summaryRows = buildArpeggioSummaryRows({
    summaryRecords: detailsByAnalysis?.contacts?.contact_residue_summary ?? [],
    annotationByPosition,
  });
  const model = buildArpeggioModel({
    summaryRows,
    contactRows: detailsByAnalysis?.contacts?.contacts_long ?? [],
    sequence,
    metric: 'contacts',
  });
  if (!model.hasPublishedRows) return null;
  const residues = new Map(model.sequenceRows.filter((row) => row.published).map((row) => {
    const summary = summaryRows.get(row.position);
    return [row.position, {
      value: row.value,
      color: row.color,
      rows: [
        { label: 'Contactos', value: formatValue(summary?.totalContacts) },
        ...(summary?.partnerCount === null || summary?.partnerCount === undefined ? [] : [{ label: 'Residuos asociados', value: formatValue(summary.partnerCount) }]),
        ...(summary?.types?.length ? [{ label: 'Tipos publicados', value: summary.types.map(contactTypeLabel).join(' · ') }] : []),
      ],
    }];
  }));
  return {
    ...COMPARISON_ANALYSES.arpeggio,
    tracks: [{ id: 'structural_contacts_n_contacts', label: 'Contactos por residuo', colors: ARPEGGIO_SCALE_COLORS, domain: model.domain }],
    residues,
    legend: {
      kind: 'continuous', colors: ARPEGGIO_SCALE_COLORS, domain: model.domain,
      minLabel: '0', maxLabel: formatScaleNumber(model.domain.max),
      sourceUrl: ARPEGGIO_REFERENCE_URL,
      sourceLabel: 'PDBe Arpeggio',
    },
  };
}

function frustrationTrack(fieldConfig, byPosition, sequence) {
  const published = [];
  for (let position = 1; position <= sequence.length; position += 1) {
    const row = byPosition.get(position);
    const value = finiteAnnotationValue(row?.values?.[fieldConfig.field]);
    if (value !== null) published.push({ position, row, value });
  }
  if (!published.length) return null;
  const observedValues = published.map(({ value }) => value);
  let domain;
  if (fieldConfig.field === 'frustratometer_mean') {
    domain = fixedDomainForMode('frustration');
  } else if (fieldConfig.field === 'frustraiseq_entropy') {
    domain = {
      ...FRUSTRAISEQ_ENTROPY_DOMAIN,
      observedMin: Math.min(...observedValues),
      observedMax: Math.max(...observedValues),
    };
  } else if (fieldConfig.field === 'frustraiseq_surprisal') {
    domain = {
      ...FRUSTRAISEQ_SURPRISAL_DOMAIN,
      observedMin: Math.min(...observedValues),
      observedMax: Math.max(...observedValues),
    };
  } else {
    domain = numericDomain(observedValues);
  }
  let colors;
  if (fieldConfig.field === 'frustratometer_mean') {
    colors = VISUALIZATION_MODES.frustration.colors;
  } else if (fieldConfig.field === 'frustraiseq_entropy') {
    colors = FRUSTRAISEQ_ENTROPY_COLORS;
  } else if (fieldConfig.field === 'frustraiseq_surprisal') {
    colors = FRUSTRAISEQ_SURPRISAL_COLORS;
  } else {
    colors = [FRUSTRATION_CLASS_INFO.highly_frustrated.color, FRUSTRATION_CLASS_INFO.neutral.color, FRUSTRATION_CLASS_INFO.minimally_frustrated.color];
  }
  const categorical = fieldConfig.field !== 'frustratometer_mean'
    && !['frustraiseq_entropy', 'frustraiseq_surprisal'].includes(fieldConfig.field);
  const categories = categorical ? [
    { key: 'highly_frustrated', ...FRUSTRATION_CLASS_INFO.highly_frustrated },
    { key: 'neutral', ...FRUSTRATION_CLASS_INFO.neutral },
    { key: 'minimally_frustrated', ...FRUSTRATION_CLASS_INFO.minimally_frustrated },
  ] : null;
  const upperCutoff = fieldConfig.field === 'frustraiseq_index'
    ? FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF
    : fieldConfig.field.startsWith('structural_frustration_fi_')
      ? minimallyFrustratedCutoff(fieldConfig.field)
      : null;
  const units = [...new Set(published.map(({ row }) => unitFor(row, fieldConfig.field)).filter(Boolean))];
  const unit = units.length === 1 ? units[0] : null;
  const scaleTicks = fieldConfig.field === 'frustraiseq_entropy'
    ? ['0', '0.25', '0.50', '0.75', '1']
    : fieldConfig.field === 'frustraiseq_surprisal'
      ? ['−3', '−2', '−1', '0', '+1', '+2', '+3']
      : null;
  const scaleSegments = categorical && (fieldConfig.kind === 'frustratometer' || fieldConfig.field === 'frustraiseq_index') ? [
    {
      key: 'highly_frustrated',
      color: FRUSTRATION_CLASS_INFO.highly_frustrated.color,
      label: `< ${formatValue(HIGHLY_FRUSTRATED_CUTOFF, unit)}`,
    },
    {
      key: 'neutral',
      color: FRUSTRATION_CLASS_INFO.neutral.color,
      label: `${formatValue(HIGHLY_FRUSTRATED_CUTOFF, unit)}–${formatValue(upperCutoff, unit)}`,
    },
    {
      key: 'minimally_frustrated',
      color: FRUSTRATION_CLASS_INFO.minimally_frustrated.color,
      label: `> ${formatValue(upperCutoff, unit)}`,
    },
  ] : null;
  const values = new Map();
  const usedCategories = new Set();
  for (const { position, row, value } of published) {
    const publishedClass = row?.values?.frustraiseq_class;
    const color = fieldConfig.field === 'frustratometer_mean'
      ? colorOnScale(normalizeValue(value, domain.min, domain.max), colors)
      : colorForFrustrationMetric({ value, field: fieldConfig.field, domain, publishedClass });
    const publishedClassName = normalizeFrustrationClass(publishedClass);
    const className = fieldConfig.field === 'frustraiseq_index'
      ? publishedClassName !== 'unknown' ? publishedClassName : classifyFrustrAISeqIndex(value)
      : fieldConfig.field.startsWith('structural_frustration_fi_')
        ? classifyFrustratometerValue(value, fieldConfig.field)
        : null;
    if (className && className !== 'unknown') usedCategories.add(className);
    values.set(position, {
      value,
      color,
      rows: [
        { label: fieldConfig.label, value: formatValue(value, unitFor(row, fieldConfig.field)) },
        ...(className && className !== 'unknown' ? [{ label: 'Clase', value: frustrationClassLabel(className) }] : []),
      ],
    });
  }
  return {
    ...fieldConfig,
    domain,
    colors,
    unit,
    scaleTicks,
    scaleSegments,
    categorical,
    categories: categories?.filter(({ key }) => usedCategories.has(key)) ?? null,
    cutoffNote: categorical && !scaleSegments ? `Cortes publicados: < ${HIGHLY_FRUSTRATED_CUTOFF}; > ${upperCutoff}` : null,
    scaleNote: null,
    values,
    sourceUrl: fieldConfig.kind === 'frustraiseq' ? FRUSTRAISEQ_REFERENCE_URL : FRUSTRATOMETER_REFERENCE_URL,
  };
}

function frustrationEntry(sequence, byPosition) {
  const tracks = FRUSTRATION_FIELDS.map((field) => frustrationTrack(field, byPosition, sequence)).filter(Boolean);
  if (!tracks.length) return null;
  const residues = new Map();
  for (let position = 1; position <= sequence.length; position += 1) {
    const available = tracks.map((track) => ({ track, datum: track.values.get(position) })).filter(({ datum }) => datum);
    if (!available.length) continue;
    residues.set(position, {
      value: available[0].datum.value,
      color: available[0].datum.color,
      trackValues: new Map(available.map(({ track, datum }) => [track.field, datum])),
      rows: available.flatMap(({ track, datum }) => datum.rows.map((row) => ({ ...row, source: track.source }))),
    });
  }
  return {
    ...COMPARISON_ANALYSES.frustration,
    tracks: tracks.map((track) => ({
      id: track.field,
      label: track.label,
      source: track.source,
      colors: track.colors,
      domain: track.domain,
      unit: track.unit,
      scaleTicks: track.scaleTicks,
      scaleSegments: track.scaleSegments,
      sourceUrl: track.sourceUrl,
      categorical: track.categorical,
      categories: track.categories,
      cutoffNote: track.cutoffNote,
      scaleNote: track.scaleNote,
    })),
    residues,
    legend: { kind: 'multi', tracks },
  };
}

export function buildAvailableComparisonAnalyses({ sequence = '', annotations = [], detailsByAnalysis = {} } = {}) {
  const byPosition = annotationRows(annotations, detailsByAnalysis);
  const entries = {
    conservation: conservationEntry(sequence, byPosition),
    topology: topologyEntry(sequence, byPosition),
    ddg: ddgEntry(detailsByAnalysis, annotations),
    arpeggio: arpeggioEntry(sequence, detailsByAnalysis, annotations),
    frustration: frustrationEntry(sequence, byPosition),
  };
  return COMPARISON_ANALYSIS_ORDER.map((id) => entries[id]).filter(Boolean);
}

export function selectFrustrationMetric(analyses, metricId) {
  return analyses.map((analysis) => {
    if (analysis.id !== 'frustration') return analysis;
    const track = analysis.tracks.find((item) => item.id === metricId) ?? analysis.tracks[0];
    if (!track) return analysis;
    const residues = new Map();
    for (const [position, datum] of analysis.residues) {
      const selectedDatum = datum.trackValues?.get(track.id);
      if (!selectedDatum) continue;
      residues.set(position, {
        ...datum,
        value: selectedDatum.value,
        color: selectedDatum.color,
        rows: selectedDatum.rows.map((row) => ({ ...row, source: track.source })),
        trackValues: new Map([[track.id, selectedDatum]]),
      });
    }
    return {
      ...analysis,
      source: track.source,
      tracks: [track],
      residues,
      legend: { kind: 'multi', tracks: [track] },
      selectedMetricId: track.id,
    };
  });
}

export function composeComparisonSignals({ sequence = '', analyses = [], activeIds = [] } = {}) {
  const available = new Map(analyses.map((analysis) => [analysis.id, analysis]));
  const active = activeIds.map((id) => available.get(id)).filter(Boolean);
  const residues = [...String(sequence)].map((aa, index) => {
    const position = index + 1;
    return {
      aa,
      position,
      channels: active.map((analysis, channelIndex) => {
        const datum = analysis.residues.get(position) ?? null;
        const trackColors = analysis.tracks.map((track) => (
          datum?.trackValues?.get(track.id)?.color ?? (analysis.tracks.length === 1 ? datum?.color : null) ?? COMPARISON_MISSING_COLOR
        ));
        return {
          analysisId: analysis.id,
          analysisLabel: analysis.label,
          channelIndex,
          hasData: Boolean(datum),
          colors: trackColors,
          datum,
        };
      }),
    };
  });
  return { active, residues };
}

export function reorderActiveAnalyses(activeIds, id, direction) {
  const index = activeIds.indexOf(id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= activeIds.length) return [...activeIds];
  const next = [...activeIds];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function toggleActiveAnalysis(activeIds, id) {
  return activeIds.includes(id) ? activeIds.filter((item) => item !== id) : [...activeIds, id];
}

export function selectedResidueSections(composition, position, availableAnalyses = []) {
  if (!Number.isInteger(position)) return [];
  const residue = composition.residues[position - 1];
  if (!residue) return [];
  const analysesById = new Map(availableAnalyses.map((analysis) => [analysis.id, analysis]));
  return residue.channels.flatMap((channel) => {
    const allFrustration = channel.analysisId === 'frustration' ? analysesById.get('frustration') : null;
    const frustrationDatum = allFrustration?.residues.get(position) ?? null;
    const datum = frustrationDatum ?? (channel.hasData ? channel.datum : null);
    if (!datum) return [];
    return [{
      analysisId: channel.analysisId,
      label: channel.analysisLabel,
      source: allFrustration?.source ?? composition.active[channel.channelIndex]?.source ?? null,
      channel: channel.channelIndex + 1,
      colors: channel.colors,
      rows: datum.rows,
      note: datum.note ?? null,
    }];
  });
}
