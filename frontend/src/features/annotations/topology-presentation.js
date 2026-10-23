export const TOPOLOGY_CLASSES = {
  tm_alpha: {
    label: 'Hélice transmembrana α',
    shortLabel: 'Hélice TM α',
    color: '#2f9e5b',
    probabilityField: 'p_tm_alpha',
  },
  tm_beta: {
    label: 'Lámina transmembrana β',
    shortLabel: 'Lámina TM β',
    color: '#148f8d',
    probabilityField: 'p_tm_beta',
  },
  outside: {
    label: 'Exterior',
    shortLabel: 'Exterior',
    color: '#2b78d0',
    probabilityField: 'p_outside',
  },
  inside: {
    label: 'Interior',
    shortLabel: 'Interior',
    color: '#e87926',
    probabilityField: 'p_inside',
  },
  signal_peptide: {
    label: 'Péptido señal',
    shortLabel: 'Péptido señal',
    color: '#20aeb4',
    probabilityField: 'p_signal',
  },
  unknown: {
    label: 'Sin dato',
    shortLabel: 'Sin dato',
    color: '#b8bec5',
    probabilityField: null,
  },
};

const TOPOLOGY_ALIASES = {
  alpha: 'tm_alpha',
  beta: 'tm_beta',
  tmhelix: 'tm_alpha',
  tmstrand: 'tm_beta',
  signal: 'signal_peptide',
};

export function normalizeTopologyClass(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const canonical = TOPOLOGY_ALIASES[normalized] ?? normalized;
  return Object.hasOwn(TOPOLOGY_CLASSES, canonical) ? canonical : 'unknown';
}

export function topologyClassProbability(record, topologyClass) {
  const field = TOPOLOGY_CLASSES[normalizeTopologyClass(topologyClass)].probabilityField;
  if (!field) return null;
  const value = Number(record?.[field]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function topologyRegions(rows) {
  const ordered = [...(rows ?? [])]
    .filter((row) => Number.isInteger(Number(row?.position)) && Number(row.position) > 0)
    .sort((left, right) => Number(left.position) - Number(right.position));
  const regions = [];
  for (const row of ordered) {
    const position = Number(row.position);
    const topologyClass = normalizeTopologyClass(row.topologyClass);
    const previous = regions.at(-1);
    if (previous && previous.topologyClass === topologyClass && previous.end + 1 === position) {
      previous.end = position;
      previous.count += 1;
    } else {
      regions.push({ topologyClass, start: position, end: position, count: 1 });
    }
  }
  return regions;
}

export function structureSelectionItems(structureByCanonical, start, end) {
  const items = [];
  const first = Number(start);
  const last = Number(end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) return items;
  for (let position = first; position <= last; position += 1) {
    const key = structureByCanonical?.get?.(position);
    if (!key) continue;
    const [chain, residueNumber, insertionCode] = String(key).split('|');
    const authSeqId = Number(residueNumber);
    if (!Number.isInteger(authSeqId)) continue;
    items.push({
      auth_asym_id: chain || 'A',
      auth_seq_id: authSeqId,
      ...(insertionCode ? { pdbx_PDB_ins_code: insertionCode } : {}),
    });
  }
  return items;
}

export function topologyCounts(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const topologyClass = normalizeTopologyClass(row?.topologyClass);
    counts.set(topologyClass, (counts.get(topologyClass) ?? 0) + 1);
  }
  return counts;
}

export function membraneStatus(spanMetadata, segmentCount) {
  if (Number(segmentCount) > 0) {
    const orientation = String(spanMetadata?.orientation ?? '').trim();
    return {
      label: 'Disponible',
      reason: 'La corrida publicó al menos un segmento transmembrana.',
      orientation: orientation && orientation.toUpperCase() !== 'NA' ? orientation : null,
    };
  }
  return {
    label: 'No aplica',
    reason: String(spanMetadata?.reason ?? '').trim() || 'TMbed no publicó segmentos transmembrana.',
    orientation: null,
  };
}
