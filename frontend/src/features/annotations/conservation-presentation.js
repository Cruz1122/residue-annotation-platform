// Conservation keeps the scientific contract separate from the shared viewer.
// The stage publishes two different measurements: an ordinal ConSurf grade and
// a continuous Rate4Site score. They must never share a colour scale.

export const CONSERVATION_REFERENCE_URL = 'https://doi.org/10.1093/nar/gkw408';
export const RATE4SITE_REFERENCE_URL = 'https://doi.org/10.1093/bioinformatics/18.suppl_1.S71';

export const CONSERVATION_SCALE = Object.freeze({
  min: 1,
  max: 9,
  ticks: Object.freeze([1, 3, 5, 7, 9]),
  lowLabel: 'Variable',
  highLabel: 'Conservado',
  sourceLabel: 'ConSurf 2016',
  sourceUrl: CONSERVATION_REFERENCE_URL,
});

const CONSERVATION_FIELDS = Object.freeze([
  'consurf_grade',
  'rate4site_score',
]);

const DETAIL_FIELDS = Object.freeze([
  ...CONSERVATION_FIELDS,
  'consurf_grade_raw',
  'rate4site_score_raw',
  'ci_low',
  'ci_high',
  'ci_grade_span',
  'reliable',
  'nongap',
  'na_reason',
]);

function isMissing(value) {
  return value === null
    || value === undefined
    || value === ''
    || String(value).trim().toUpperCase() === 'NA';
}

function present(value) {
  return !isMissing(value);
}

function numericValue(value) {
  if (!present(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeConservationGrade(value) {
  const number = numericValue(value);
  if (!Number.isInteger(number) || number < CONSERVATION_SCALE.min || number > CONSERVATION_SCALE.max) return null;
  return number;
}

export function isValidConservationGrade(value) {
  return normalizeConservationGrade(value) !== null;
}

export function publishedConservationField(values, field) {
  if (!values || !CONSERVATION_FIELDS.includes(field)) return null;
  const value = values[field];
  return present(value) ? value : null;
}

export function publishedConservationMetrics(values) {
  return Object.fromEntries(
    CONSERVATION_FIELDS
      .map((field) => [field, publishedConservationField(values, field)])
      .filter(([, value]) => value !== null),
  );
}

function valueFromRecord(record, field) {
  if (!record || typeof record !== 'object') return null;
  const direct = record[field];
  if (present(direct)) return direct;
  const nested = record.values?.[field];
  return present(nested) ? nested : null;
}

export function conservationDetailValue(record, field) {
  if (!DETAIL_FIELDS.includes(field)) return null;
  return valueFromRecord(record, field);
}

export function conservationEvidenceForResidue(annotation, detail) {
  const values = annotation?.values ?? {};
  const units = annotation?.units ?? {};
  const pick = (field) => publishedConservationField(values, field) ?? conservationDetailValue(detail, field);
  const grade = pick('consurf_grade');
  const rate4site = pick('rate4site_score');
  const ciLow = conservationDetailValue(detail, 'ci_low');
  const ciHigh = conservationDetailValue(detail, 'ci_high');
  const ciGradeSpan = conservationDetailValue(detail, 'ci_grade_span');
  const reliable = conservationDetailValue(detail, 'reliable');
  const nongap = conservationDetailValue(detail, 'nongap');
  const naReason = conservationDetailValue(detail, 'na_reason');

  return {
    consurfGrade: grade,
    rate4siteScore: rate4site,
    rate4siteUnit: present(units.rate4site_score)
      ? units.rate4site_score
      : unitFromRecord(detail, 'rate4site_score'),
    ciLow,
    ciHigh,
    ciGradeSpan,
    reliable,
    nongap,
    naReason,
    hasPublishedMetric: grade !== null || rate4site !== null,
  };
}

function positionFromRecord(record) {
  for (const key of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const number = Number(record?.[key]);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function referenceFromRecord(record) {
  const value = String(record?.aa_ref ?? record?.reference_aa ?? '').trim().toUpperCase();
  return /^[A-Z]$/.test(value) ? value : undefined;
}

function unitFromRecord(record, field) {
  const fieldUnit = record?.[`${field}_unit`];
  if (present(fieldUnit)) return fieldUnit;
  const units = record?.units;
  if (typeof units === 'string' && present(units)) return units;
  if (units && typeof units === 'object' && present(units[field])) return units[field];
  return null;
}

function detailValues(record) {
  const values = {};
  const units = {};
  for (const field of CONSERVATION_FIELDS) {
    const value = valueFromRecord(record, field);
    if (value === null) continue;
    values[field] = value;
    const unit = unitFromRecord(record, field);
    if (unit !== null) units[field] = unit;
  }
  return { values, units };
}

/**
 * Project the real per-residue conservation artifact into the same annotation
 * row shape used by the API. Missing artifact values are omitted, never
 * converted to zero, and never allowed to overwrite a value from annotations.
 */
export function conservationRowsFromArtifact(records) {
  return (records ?? []).flatMap((record) => {
    const aaPosition = positionFromRecord(record);
    if (!aaPosition) return [];
    const { values, units } = detailValues(record);
    if (!Object.keys(values).length) return [];
    return [{
      aa_position: aaPosition,
      aa_ref: referenceFromRecord(record),
      stage_id: 'evolutionary_conservation_artifact',
      values,
      units,
    }];
  });
}

function formatNumber(value) {
  const number = numericValue(value);
  if (number === null) return String(value);
  if (Number.isInteger(number)) return String(number);
  return String(Math.round(number * 1000) / 1000);
}

export function formatConservationGrade(value) {
  if (!present(value)) return 'Sin dato publicado';
  const grade = normalizeConservationGrade(value);
  return grade === null ? String(value) : `${grade} / ${CONSERVATION_SCALE.max}`;
}

export function formatConservationInterval(low, high) {
  if (!present(low) && !present(high)) return null;
  if (present(low) && present(high)) return `${formatNumber(low)}–${formatNumber(high)}`;
  return formatNumber(present(low) ? low : high);
}

function normalizeKey(key) {
  return String(key ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

const PROVENANCE_LABELS = new Map([
  ['method', 'Método'],
  ['methodology', 'Metodología'],
  ['tool', 'Herramienta'],
  ['software', 'Software'],
  ['version', 'Versión'],
  ['database', 'Base de datos'],
  ['source', 'Procedencia'],
  ['alignment_source', 'Fuente del alineamiento'],
  ['alignment_method', 'Método de alineamiento'],
  ['reference', 'Referencia publicada'],
  ['citation', 'Cita'],
  ['doi', 'DOI'],
]);

function scalar(value) {
  return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && present(value)
    ? String(value)
    : null;
}

/**
 * Keep only scientific provenance fields that are actually present. The API
 * may expose operational provenance beside them; it is deliberately ignored
 * instead of being presented as a scientific result.
 */
export function conservationProvenance(metadata, stageProvenance = null) {
  const rows = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = normalizeKey(rawKey);
      const label = PROVENANCE_LABELS.get(key);
      const valueText = scalar(rawValue);
      if (label && valueText) {
        const signature = `${label}|${valueText}`;
        if (!seen.has(signature)) {
          seen.add(signature);
          rows.push({ label, value: valueText, key });
        }
      }
      if (!valueText && rawValue && typeof rawValue === 'object') visit(rawValue, depth + 1);
    }
  };
  visit(metadata);
  visit(stageProvenance);
  return rows;
}
