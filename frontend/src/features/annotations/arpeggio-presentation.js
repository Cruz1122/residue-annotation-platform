import {
  AA3,
  AA_NAMES,
  colorOnScale,
  finiteAnnotationValue,
  formatScaleNumber,
  normalizeValue,
} from './viewer-presentation.js';

export const ARPEGGIO_REFERENCE_URL = 'https://doi.org/10.1016/j.jmb.2016.12.004';
export const ARPEGGIO_SOURCE_LABEL = 'Jubb et al., 2017';
export const ARPEGGIO_CAVEAT = 'Los contactos describen la estructura y no implican patogenicidad, estabilidad ni función.';

// The published Arpeggio contact flags. `proximal` and `vdw_clash` are
// intentionally separate from chemical contacts: proximal is distance-only and
// vdw_clash is a steric overlap. Neither is added to contact counts.
export const ARPEGGIO_CONTACT_TYPES = {
  hbond: {
    label: 'Puente de hidrógeno',
    shortLabel: 'H-bond',
    color: '#bf3f3f',
    priority: 10,
    contact: true,
  },
  weak_hbond: {
    label: 'Puente de hidrógeno débil',
    shortLabel: 'H-bond débil',
    color: '#d9776a',
    priority: 20,
    contact: true,
  },
  ionic: {
    label: 'Iónico',
    shortLabel: 'Iónico',
    color: '#8e44ad',
    priority: 30,
    contact: true,
  },
  hydrophobic: {
    label: 'Hidrofóbico',
    shortLabel: 'Hidrofóbico',
    color: '#b97812',
    priority: 40,
    contact: true,
  },
  aromatic: {
    label: 'Aromático',
    shortLabel: 'Aromático',
    color: '#7d3c98',
    priority: 50,
    contact: true,
  },
  carbonyl: {
    label: 'Carbonilo',
    shortLabel: 'Carbonilo',
    color: '#178f7a',
    priority: 60,
    contact: true,
  },
  polar: {
    label: 'Polar',
    shortLabel: 'Polar',
    color: '#2f6fb0',
    priority: 70,
    contact: true,
  },
  weak_polar: {
    label: 'Polar débil (donador débil)',
    shortLabel: 'Polar débil',
    color: '#6b9bd1',
    priority: 80,
    contact: true,
  },
  vdw: {
    label: 'van der Waals',
    shortLabel: 'vdW',
    color: '#7f8c8d',
    priority: 90,
    contact: true,
  },
  xbond: {
    label: 'Enlace de halógeno',
    shortLabel: 'Halógeno',
    color: '#2e8b57',
    priority: 100,
    contact: true,
  },
  metal_complex: {
    label: 'Coordinación metálica',
    shortLabel: 'Metal',
    color: '#5d6d7e',
    priority: 110,
    contact: true,
  },
  proximal: {
    label: 'Solo distancia',
    shortLabel: 'Proximidad',
    color: '#b8bec5',
    priority: 200,
    contact: false,
  },
  vdw_clash: {
    label: 'Choque de van der Waals',
    shortLabel: 'Choque vdW',
    color: '#a93a3a',
    priority: 210,
    contact: false,
  },
  clash: {
    label: 'Choque estérico',
    shortLabel: 'Choque',
    color: '#a93a3a',
    priority: 220,
    contact: false,
  },
  covalent: {
    label: 'Covalente',
    shortLabel: 'Covalente',
    color: '#5d6d7e',
    priority: 230,
    contact: false,
  },
};

const CONTACT_TYPE_ALIASES = {
  'vdw-clash': 'vdw_clash',
  'weak-polar': 'weak_polar',
  'weak-hbond': 'weak_hbond',
  halogen: 'xbond',
  metal: 'metal_complex',
};

export const ARPEGGIO_METRICS = {
  contacts: {
    value: 'contacts',
    label: 'Contactos',
    shortLabel: 'Contactos',
    description: 'Pares residuo–socio con al menos un tipo de interacción publicado; cada tipo cuenta una vez.',
  },
  partners: {
    value: 'partners',
    label: 'Residuos asociados',
    shortLabel: 'Residuos asociados',
    description: 'Residuos distintos que forman al menos un contacto con el residuo.',
  },
};

export const ARPEGGIO_METRIC_OPTIONS = Object.values(ARPEGGIO_METRICS).map((metric) => ({
  value: metric.value,
  label: metric.label,
}));

// This is a visual encoding of integer counts over the observed run domain,
// not a published scientific classification. It never describes confidence or
// activity.
export const ARPEGGIO_SCALE_COLORS = ['#7fbfa8', '#4fa88a', '#2f8f72', '#1f735b', '#11543f'];
export const ARPEGGIO_PARTNER_SCALE_COLORS = ['#7faed9', '#4a83c1', '#2f66a3', '#1d4f91', '#123b6f'];

export const ARPEGGIO_ROLE_COLORS = {
  selectedMissing: '#172126',
  partner: '#2f6fb0',
  context: '#d6dcde',
};

const EXCLUDED_DETAIL_TYPES = new Set(['proximal', 'vdw_clash', 'clash', 'covalent']);

function positivePosition(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  return finiteAnnotationValue(value);
}

function normalizedText(value) {
  return String(value ?? '').trim();
}

function normalizedInsertionCode(value) {
  const text = normalizedText(value);
  return text && text.toUpperCase() !== 'NA' ? text : '';
}

function normalizedContactType(value) {
  const normalized = normalizedText(value)
    .toLowerCase()
    .replace(/\s+/g, '_');
  const canonical = CONTACT_TYPE_ALIASES[normalized] ?? normalized;
  return Object.hasOwn(ARPEGGIO_CONTACT_TYPES, canonical) ? canonical : null;
}

export function isContactType(type) {
  return Boolean(ARPEGGIO_CONTACT_TYPES[type]?.contact);
}

export function parseContactTypeList(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[,;|]/);
  const types = new Set();
  for (const item of values) {
    const type = normalizedContactType(item);
    if (type && isContactType(type)) types.add(type);
  }
  return [...types].sort(compareContactTypes);
}

export function compareContactTypes(left, right) {
  const a = ARPEGGIO_CONTACT_TYPES[left];
  const b = ARPEGGIO_CONTACT_TYPES[right];
  return (a?.priority ?? 999) - (b?.priority ?? 999) || String(left).localeCompare(String(right));
}

export function contactTypeLabel(type) {
  return ARPEGGIO_CONTACT_TYPES[type]?.label ?? normalizedText(type);
}

export function contactTypeShortLabel(type) {
  return ARPEGGIO_CONTACT_TYPES[type]?.shortLabel ?? normalizedText(type);
}

export function contactTypeColor(type) {
  return ARPEGGIO_CONTACT_TYPES[type]?.color ?? '#7f8c8d';
}

function normalizedStructureValue(value) {
  const text = normalizedText(value);
  return text && text.toUpperCase() !== 'NA' ? text : '';
}

export function structureKeyFromParts(chain, resseq, icode = '') {
  const residueNumber = normalizedStructureValue(resseq);
  if (!residueNumber) return '';
  return `${normalizedStructureValue(chain) || '?'}|${residueNumber}|${normalizedInsertionCode(icode)}`;
}

function firstValue(record, annotation, key) {
  for (const source of [record, annotation?.values, annotation]) {
    if (!source || !Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value !== null && value !== undefined && value !== '' && value !== 'NA') return value;
  }
  return null;
}

export function normalizeSummaryRecord(record, annotation = null) {
  const position = positivePosition(
    record?.aa_position
    ?? record?.position
    ?? annotation?.aa_position,
  );
  if (position === null) return null;
  const aa = normalizedText(record?.aa_ref ?? annotation?.aa_ref).toUpperCase();
  const totalContacts = finiteNumber(firstValue(record, annotation, 'structural_contacts_n_contacts'));
  const partnerCount = finiteNumber(firstValue(record, annotation, 'structural_contacts_n_partner_residues'));
  const clashPartnerCount = finiteNumber(firstValue(record, annotation, 'structural_contacts_n_vdw_clash_partners'));
  const status = normalizedText(firstValue(record, annotation, 'structural_contacts_status')).toLowerCase();
  const statusOk = !status || status === 'ok' || status === 'success';
  const chain = normalizedStructureValue(record?.chain);
  const resseq = normalizedStructureValue(record?.resseq ?? record?.residue_number);
  const icode = normalizedInsertionCode(record?.icode ?? record?.insertion_code);
  const types = parseContactTypeList(firstValue(record, annotation, 'structural_contacts_contact_types'));
  return {
    position,
    aa,
    chain: chain || '',
    resseq,
    icode,
    structureKey: structureKeyFromParts(chain, resseq, icode),
    totalContacts,
    partnerCount,
    clashPartnerCount,
    types,
    published: statusOk && (totalContacts !== null || partnerCount !== null),
    status: status || null,
    qcStatus: annotation?.qc_status ?? (status || null),
  };
}

export function buildArpeggioSummaryRows({ summaryRecords = [], annotationByPosition = new Map() } = {}) {
  const rows = new Map();
  for (const record of summaryRecords ?? []) {
    const row = normalizeSummaryRecord(record, annotationByPosition.get(Number(record?.aa_position)));
    if (row) rows.set(row.position, row);
  }
  for (const [position, annotation] of annotationByPosition) {
    if (rows.has(position)) continue;
    const row = normalizeSummaryRecord(null, annotation);
    if (row) rows.set(row.position, row);
  }
  return rows;
}

function structureKeyFromContact(record, side) {
  const chain = record?.[`chain_${side}`];
  const resseq = record?.[`resseq_${side}`] ?? record?.[`aa_position_${side}`];
  const icode = record?.[`icode_${side}`];
  return structureKeyFromParts(chain, resseq, icode);
}

export function normalizeContactRows(records = []) {
  const rows = [];
  for (const record of records ?? []) {
    const type = normalizedContactType(record?.interaction_type);
    if (!type || !isContactType(type) || EXCLUDED_DETAIL_TYPES.has(type)) continue;
    if (String(record?.same_residue).toLowerCase() === 'true') continue;
    const distance = finiteNumber(record?.distance_A);
    const position1 = positivePosition(record?.aa_position_1 ?? record?.position_1);
    const position2 = positivePosition(record?.aa_position_2 ?? record?.position_2);
    if (distance === null || distance < 0 || position1 === null || position2 === null || position1 === position2) continue;
    rows.push({
      type,
      distance,
      position1,
      position2,
      aa1: normalizedText(record?.aa_ref_1).toUpperCase(),
      aa2: normalizedText(record?.aa_ref_2).toUpperCase(),
      key1: structureKeyFromContact(record, 1),
      key2: structureKeyFromContact(record, 2),
      atom1: normalizedText(record?.atom_1).toUpperCase(),
      atom2: normalizedText(record?.atom_2).toUpperCase(),
    });
  }
  return rows;
}

export function observedContactTypes(summaryRows, contactRows = []) {
  const types = new Set();
  for (const row of summaryRows instanceof Map ? summaryRows.values() : summaryRows ?? []) {
    for (const type of row?.types ?? []) types.add(type);
  }
  for (const row of contactRows ?? []) {
    if (isContactType(row?.type)) types.add(row.type);
  }
  return [...types].sort(compareContactTypes);
}

export function aggregateContactRows(contactRows, selectedTypes = null) {
  const allowed = selectedTypes ? new Set(selectedTypes) : null;
  const byPosition = new Map();
  const ensure = (position) => {
    let entry = byPosition.get(position);
    if (!entry) {
      entry = { position, contacts: new Set(), partners: new Map(), types: new Set() };
      byPosition.set(position, entry);
    }
    return entry;
  };
  for (const row of contactRows ?? []) {
    if (allowed && !allowed.has(row.type)) continue;
    for (const side of [1, 2]) {
      const self = side === 1
        ? { position: row.position1, aa: row.aa1, key: row.key1, atom: row.atom1 }
        : { position: row.position2, aa: row.aa2, key: row.key2, atom: row.atom2 };
      const partner = side === 1
        ? { position: row.position2, aa: row.aa2, key: row.key2, atom: row.atom2 }
        : { position: row.position1, aa: row.aa1, key: row.key1, atom: row.atom1 };
      const entry = ensure(self.position);
      entry.contacts.add(`${partner.position}|${row.type}`);
      entry.types.add(row.type);
      let partnerEntry = entry.partners.get(partner.position);
      if (!partnerEntry) {
        partnerEntry = {
          position: partner.position,
          aa: partner.aa,
          structureKey: partner.key,
          types: new Set(),
          byType: new Map(),
          minDistance: Number.POSITIVE_INFINITY,
        };
        entry.partners.set(partner.position, partnerEntry);
      }
      partnerEntry.types.add(row.type);
      if (row.distance < partnerEntry.minDistance) partnerEntry.minDistance = row.distance;
      const previous = partnerEntry.byType.get(row.type);
      if (!previous || row.distance < previous.distance) {
        partnerEntry.byType.set(row.type, {
          distance: row.distance,
          selfKey: self.key,
          selfAtom: self.atom,
          partnerKey: partner.key,
          partnerAtom: partner.atom,
        });
      }
    }
  }
  return byPosition;
}

function detailMatchesSummary(row, aggregate) {
  if (!row || !row.published) return false;
  const contacts = aggregate?.contacts?.size ?? 0;
  const partners = aggregate?.partners?.size ?? 0;
  if (row.totalContacts !== null && contacts !== row.totalContacts) return false;
  if (row.partnerCount !== null && partners !== row.partnerCount) return false;
  const detailTypes = aggregate?.types ? [...aggregate.types] : [];
  if (row.types.length !== detailTypes.length) return false;
  if (row.types.some((type) => !aggregate?.types?.has(type))) return false;
  return true;
}

export function colorForArpeggioValue(value, domain, colors = ARPEGGIO_SCALE_COLORS) {
  const number = finiteNumber(value);
  if (number === null) return null;
  if (!domain || domain.max <= 0) return colors[0];
  return colorOnScale(normalizeValue(number, domain.min, domain.max), colors);
}

export function buildArpeggioRoleColors({
  referenceMatched = true,
  selectedStructureKey = '',
  selectedColor = null,
  selectedPublished = false,
  partners = [],
  partnerColor = ARPEGGIO_ROLE_COLORS.partner,
} = {}) {
  const colors = new Map();
  if (!referenceMatched) return colors;
  if (selectedStructureKey) {
    colors.set(selectedStructureKey, selectedPublished && selectedColor ? selectedColor : ARPEGGIO_ROLE_COLORS.selectedMissing);
  }
  for (const partner of partners) {
    if (partner?.structureKey) colors.set(partner.structureKey, partner.color || partnerColor);
  }
  return colors;
}

export function residueInfo(sequence, position) {
  const index = Number(position);
  const one = Number.isInteger(index) && index > 0 ? String(sequence ?? '')[index - 1] ?? '' : '';
  const code = AA3[one] ?? '';
  return {
    one: one || '—',
    code,
    name: code ? AA_NAMES[code] : 'Selecciona un residuo',
    label: one ? `${one}${index}` : '—',
  };
}

export function formatArpeggioCount(value) {
  const number = finiteNumber(value);
  return number === null ? 'Sin dato' : formatScaleNumber(number);
}

export function formatArpeggioDistance(value) {
  const number = finiteNumber(value);
  return number === null ? 'Sin dato' : `${formatScaleNumber(number)} Å`;
}

export function arpeggioMethodLabel(provenance) {
  const parameters = provenance?.parameters ?? {};
  const parts = ['PDBe Arpeggio'];
  const interacting = finiteNumber(parameters.interacting_A);
  if (interacting !== null) parts.push(`radio de búsqueda ${formatScaleNumber(interacting)} Å`);
  const ph = finiteNumber(parameters.ph);
  if (ph !== null) parts.push(`pH ${formatScaleNumber(ph)}`);
  return parts.join(' · ');
}

function sortedPartnerRows(aggregate) {
  if (!aggregate) return [];
  return [...aggregate.partners.values()]
    .map((partner) => {
      const types = [...partner.types].filter(isContactType).sort(compareContactTypes);
      const primaryType = types[0] ?? null;
      const representative = primaryType ? partner.byType.get(primaryType) : null;
      return {
        position: partner.position,
        aa: partner.aa,
        types,
        primaryType,
        color: primaryType ? contactTypeColor(primaryType) : '#7f8c8d',
        minDistance: partner.minDistance,
        structureKey: representative?.partnerKey || partner.structureKey,
        selfStructureKey: representative?.selfKey ?? '',
        selfAtom: representative?.selfAtom ?? '',
        partnerAtom: representative?.partnerAtom ?? '',
      };
    })
    .sort((left, right) => left.minDistance - right.minDistance || left.position - right.position);
}

export function buildArpeggioModel({
  summaryRows = new Map(),
  contactRows = [],
  allDetailByPosition: suppliedAllDetailByPosition = null,
  filteredDetailByPosition: suppliedFilteredDetailByPosition = null,
  knownObservedTypes = null,
  sequence = '',
  metric = 'contacts',
  selectedTypes = null,
  selectedPosition = null,
  provenance = null,
} = {}) {
  const summaryMap = summaryRows instanceof Map ? summaryRows : new Map();
  const selectedMetric = ARPEGGIO_METRICS[metric] ?? ARPEGGIO_METRICS.contacts;
  const sequenceText = String(sequence ?? '');
  const observedTypes = knownObservedTypes ?? observedContactTypes(summaryMap, contactRows);
  const scaleColors = selectedMetric.value === 'partners' ? ARPEGGIO_PARTNER_SCALE_COLORS : ARPEGGIO_SCALE_COLORS;
  const effectiveSelectedTypes = selectedTypes
    ? new Set([...selectedTypes].filter((type) => observedTypes.includes(type)))
    : new Set(observedTypes);
  const hasDetailRows = contactRows.length > 0;
  const allDetailByPosition = suppliedAllDetailByPosition ?? aggregateContactRows(contactRows, null);
  const filteredDetailByPosition = suppliedFilteredDetailByPosition ?? aggregateContactRows(contactRows, effectiveSelectedTypes);
  let hasConsistentDetail = false;
  for (const row of summaryMap.values()) {
    if (hasDetailRows && detailMatchesSummary(row, allDetailByPosition.get(row.position))) {
      hasConsistentDetail = true;
      break;
    }
  }

  const values = [];
  for (const row of summaryMap.values()) {
    if (!row.published) continue;
    const allAggregate = allDetailByPosition.get(row.position);
    const useDetail = hasDetailRows && detailMatchesSummary(row, allAggregate);
    const filteredAggregate = filteredDetailByPosition.get(row.position);
    const publishedValue = selectedMetric.value === 'contacts' ? row.totalContacts : row.partnerCount;
    const filteredValue = useDetail
      ? (selectedMetric.value === 'contacts'
        ? filteredAggregate?.contacts.size ?? 0
        : filteredAggregate?.partners.size ?? 0)
      : publishedValue;
    if (filteredValue !== null) values.push(filteredValue);
  }
  let maxValue = 0;
  for (const value of values) maxValue = Math.max(maxValue, value);
  const publishedMetricValues = [...summaryMap.values()]
    .filter((row) => row.published)
    .map((row) => (selectedMetric.value === 'contacts' ? row.totalContacts : row.partnerCount))
    .filter((value) => value !== null);
  const hasPublishedNonZero = publishedMetricValues.some((value) => value > 0);
  const filterEmpty = hasPublishedNonZero && maxValue === 0;
  const publishedAllZero = publishedMetricValues.length > 0 && publishedMetricValues.every((value) => value === 0);
  const domain = { min: 0, max: maxValue };

  const sequenceRows = [...sequenceText].map((aa, index) => {
    const position = index + 1;
    const row = summaryMap.get(position);
    const allAggregate = allDetailByPosition.get(position);
    const useDetail = hasDetailRows && detailMatchesSummary(row, allAggregate);
    const filteredAggregate = filteredDetailByPosition.get(position);
    const publishedValue = row && selectedMetric.value === 'contacts' ? row.totalContacts : row?.partnerCount ?? null;
    const value = row?.published
      ? (useDetail
        ? (selectedMetric.value === 'contacts'
          ? filteredAggregate?.contacts.size ?? 0
          : filteredAggregate?.partners.size ?? 0)
        : publishedValue)
      : null;
    return {
      position,
      aa,
      value,
      published: value !== null,
      color: value === null ? null : colorForArpeggioValue(value, domain, scaleColors),
      selected: position === selectedPosition,
    };
  });

  const selectedRow = selectedPosition === null ? null : summaryMap.get(selectedPosition) ?? null;
  const selectedAllAggregate = selectedRow ? allDetailByPosition.get(selectedRow.position) : null;
  const selectedDetailAvailable = Boolean(hasDetailRows && selectedRow && detailMatchesSummary(selectedRow, selectedAllAggregate));
  const selectedFilteredAggregate = selectedRow ? filteredDetailByPosition.get(selectedRow.position) : null;
  const selectedPublishedValue = selectedRow
    ? (selectedMetric.value === 'contacts' ? selectedRow.totalContacts : selectedRow.partnerCount)
    : null;
  const selectedValue = selectedRow?.published
    ? (selectedDetailAvailable
      ? (selectedMetric.value === 'contacts'
        ? selectedFilteredAggregate?.contacts.size ?? 0
        : selectedFilteredAggregate?.partners.size ?? 0)
      : selectedPublishedValue)
    : null;
  const selectedInfo = residueInfo(sequenceText, selectedPosition);
  const partners = selectedDetailAvailable ? sortedPartnerRows(selectedFilteredAggregate) : [];
  const selectedStructureKey = selectedRow?.structureKey
    || partners.find((partner) => partner.selfStructureKey)?.selfStructureKey
    || '';
  const selected = selectedRow
    ? {
      ...selectedRow,
      ...selectedInfo,
      value: selectedValue,
      publishedValue: selectedPublishedValue,
      color: selectedValue === null ? null : colorForArpeggioValue(selectedValue, domain, scaleColors),
      detailAvailable: selectedDetailAvailable,
      filteredContactCount: selectedDetailAvailable
        ? selectedFilteredAggregate?.contacts.size ?? 0
        : selectedRow.totalContacts,
      filteredPartnerCount: selectedDetailAvailable
        ? selectedFilteredAggregate?.partners.size ?? 0
        : selectedRow.partnerCount,
      structureKey: selectedStructureKey,
    }
    : selectedPosition === null
      ? null
      : {
        ...selectedInfo,
        position: selectedPosition,
        aa: selectedInfo.one,
        published: false,
        totalContacts: null,
        partnerCount: null,
        clashPartnerCount: null,
        types: [],
        value: null,
        publishedValue: null,
        color: null,
        detailAvailable: false,
        filteredContactCount: null,
        filteredPartnerCount: null,
        structureKey: selectedStructureKey,
      };

  const overlayContacts = selectedDetailAvailable
    ? partners.map((partner) => ({
      position: partner.position,
      label: residueInfo(sequenceText, partner.position).label,
      type: partner.primaryType,
      color: partner.color,
      distance: partner.minDistance,
      fromKey: partner.selfStructureKey,
      fromAtom: partner.selfAtom,
      toKey: partner.structureKey,
      toAtom: partner.partnerAtom,
    }))
    : [];

  const autoSelectPosition = (() => {
    const published = [...summaryMap.values()]
      .filter((row) => row.published)
      .sort((left, right) => left.position - right.position);
    return published.find((row) => (row.totalContacts ?? 0) > 0)?.position
      ?? published[0]?.position
      ?? null;
  })();

  return {
    sequenceRows,
    summaryMap,
    publishedRows: [...summaryMap.values()].filter((row) => row.published).sort((left, right) => left.position - right.position),
    observedTypes,
    selectedTypes: effectiveSelectedTypes,
    selected,
    partners,
    overlayContacts,
    hasDetailedContacts: hasConsistentDetail,
    hasPublishedRows: summaryMap.size > 0 && [...summaryMap.values()].some((row) => row.published),
    autoSelectPosition,
    domain,
    allZero: maxValue === 0,
    metric: selectedMetric,
    scale: {
      label: selectedMetric.label,
      description: selectedMetric.description,
      domain,
      colors: scaleColors,
      allZero: maxValue === 0,
      filteredEmpty: filterEmpty,
      publishedAllZero,
      note: selectedMetric.value === 'contacts' ? 'Conteo entero por residuo' : 'Residuos asociados distintos',
      methodLabel: arpeggioMethodLabel(provenance),
      sourceUrl: ARPEGGIO_REFERENCE_URL,
      sourceLabel: ARPEGGIO_SOURCE_LABEL,
      caveat: ARPEGGIO_CAVEAT,
    },
  };
}
