const AMINO_ACIDS = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));

const VARIANT_PATTERN = /^([A-Z])(\d+)([A-Z])$/;

const VARIANT_FIELDS = [
  'variant_id',
  'variant',
  'aa_position',
  'position',
  'residue_position',
  'canonical_position',
];

// These are the files a scientist can use to inspect the published result or
// reproduce its provenance. Stage indexes, variant-set JSON, and engine
// metadata remain available to the application but are not user-facing
// downloads because they duplicate the UI or expose implementation details.
const SCIENTIST_VISIBLE_VARIANT_ARTIFACT_TYPES = new Set([
  'provenance',
  'variant_annotations',
  'variant_dir',
]);

export function isScientistVisibleVariantArtifact(artifact) {
  return SCIENTIST_VISIBLE_VARIANT_ARTIFACT_TYPES.has(String(artifact?.artifact_type ?? ''));
}

function textValue(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized && normalized !== 'NA' ? normalized : '';
}

function numericPosition(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function aminoAcid(value) {
  const normalized = textValue(value);
  return AMINO_ACIDS.has(normalized) ? normalized : '';
}

function variantFromIdentifier(value) {
  const match = textValue(value).match(VARIANT_PATTERN);
  if (!match) return null;
  return {
    aa_ref: match[1],
    aa_position: Number(match[2]),
    aa_alt: match[3],
  };
}

export function normalizeVariant(value) {
  if (!value || typeof value !== 'object') return null;
  const identifier = variantFromIdentifier(value.variant_id ?? value.variant);
  const aaRef = aminoAcid(value.aa_ref ?? identifier?.aa_ref);
  const aaAlt = aminoAcid(value.aa_alt ?? identifier?.aa_alt);
  const aaPosition = numericPosition(
    value.aa_position
      ?? value.position
      ?? value.residue_position
      ?? value.canonical_position
      ?? identifier?.aa_position,
  );
  if (!aaRef || !aaAlt || aaPosition === null) return null;
  return {
    ...value,
    aa_ref: aaRef,
    aa_position: aaPosition,
    aa_alt: aaAlt,
  };
}

export function indexVariantsByPosition(variants = []) {
  const byPosition = new Map();
  for (const variant of variants ?? []) {
    const position = Number(variant?.aa_position);
    if (!Number.isInteger(position) || position < 1 || byPosition.has(position)) continue;
    byPosition.set(position, variant);
  }
  return byPosition;
}

export function variantFromRecord(record) {
  return normalizeVariant(record);
}

export function variantKey(value) {
  const variant = normalizeVariant(value);
  return variant ? `${variant.aa_ref}${variant.aa_position}${variant.aa_alt}` : '';
}

export function variantLabel(value) {
  return variantKey(value) || 'Sin variante';
}

export function variantPositions(value) {
  return [...new Set((value ?? []).map((item) => normalizeVariant(item)?.aa_position).filter(Number.isInteger))];
}

export function mergePublishedVariants(requested, records) {
  const merged = new Map();
  for (const item of [...(requested ?? []), ...(records ?? [])]) {
    const variant = normalizeVariant(item);
    if (!variant) continue;
    const key = variantKey(variant);
    const current = merged.get(key) ?? {};
    merged.set(key, { ...current, ...variant });
  }
  return [...merged.values()].sort((left, right) => left.aa_position - right.aa_position || variantKey(left).localeCompare(variantKey(right)));
}

export function variantRecordFor(records, value) {
  const key = typeof value === 'string' ? value : variantKey(value);
  if (!key) return null;
  return (records ?? []).find((record) => variantKey(record) === key) ?? null;
}

export function numericPublishedValue(record, fields) {
  for (const field of fields) {
    const raw = record?.[field] ?? record?.values?.[field];
    if (raw === null || raw === undefined || raw === '' || raw === 'NA') continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function publishedTextValue(record, fields) {
  for (const field of fields) {
    const raw = record?.[field] ?? record?.values?.[field];
    if (raw !== null && raw !== undefined && raw !== '' && raw !== 'NA') return raw;
  }
  return null;
}

export function publishedDdg(record, annotation = null, provenance = null) {
  const value = numericPublishedValue(record, ['ddg_value', 'ddg', 'energy_difference']);
  if (value === null) return null;
  const unit = publishedTextValue(record, ['ddg_unit', 'unit'])
    ?? publishedTextValue(annotation, ['ddg_unit'])
    ?? publishedTextValue(provenance, ['ddg_unit', 'unit'])
    ?? (provenance?.units && typeof provenance.units === 'object'
      ? publishedTextValue(provenance.units, ['ddg_value', 'ddg', 'energy'])
      : null);
  return { value, unit: unit ? String(unit) : null };
}

export function formatVariantNumber(value) {
  return formatPublishedNumber(value, { signed: true });
}

export function formatPublishedNumber(value, { signed = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Sin dato publicado';
  const normalized = Object.is(number, -0) ? 0 : number;
  const rounded = Math.abs(normalized) >= 10 ? normalized.toFixed(1) : normalized.toFixed(2);
  return signed && normalized > 0 ? `+${rounded}` : rounded;
}

export function replicateCount(records, variant, primaryRecord = null) {
  const direct = numericPublishedValue(primaryRecord, ['ddg_n_replicates', 'n_replicates', 'replicates']);
  if (direct !== null) return direct;
  const key = variantKey(variant);
  const rows = (records ?? []).filter((record) => !key || variantKey(record) === key);
  const replicateValues = new Set(rows.map((record) => record?.replicate ?? record?.replicate_id ?? record?.iteration).filter((value) => value !== null && value !== undefined && value !== ''));
  return replicateValues.size || null;
}

export function variantDetailRows(record, annotation, provenance) {
  const rows = [];
  const sd = numericPublishedValue(record, ['ddg_sd', 'sd', 'standard_deviation']);
  const unit = publishedTextValue(record, ['ddg_unit', 'unit'])
    ?? publishedTextValue(annotation, ['ddg_unit', 'unit'])
    ?? publishedTextValue(provenance, ['ddg_unit', 'unit']);
  if (sd !== null) rows.push({ label: 'Desviación estándar', value: sd, unit: unit ? String(unit) : null });
  return rows;
}
