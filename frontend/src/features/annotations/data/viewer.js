export const MODE_PALETTE = {
  regime: { folded: '#17823b', uncertain: '#f2b705', membrane: '#d62828' },
  frustration: { high: '#d7263d', neutral: '#59636e', minimal: '#00a6fb' },
  contacts: { low: '#51ab75', medium: '#f08a24', high: '#7c3aed' },
  conservation: { low: '#f4c430', medium: '#1565c0', high: '#e11d74' },
};

export const MODE_INFO = {
  regime: { title: 'Régimen estructural', icon: 'layers-3', legend: [['Soluble plegado', MODE_PALETTE.regime.folded], ['Incierto', MODE_PALETTE.regime.uncertain], ['Membrana', MODE_PALETTE.regime.membrane]] },
  frustration: { title: 'Frustración estructural', icon: 'activity', legend: [['Alta', MODE_PALETTE.frustration.high], ['Neutral', MODE_PALETTE.frustration.neutral], ['Mínima', MODE_PALETTE.frustration.minimal]] },
  contacts: { title: 'Contactos estructurales', icon: 'network', legend: [['Bajos', MODE_PALETTE.contacts.low], ['Medios', MODE_PALETTE.contacts.medium], ['Altos', MODE_PALETTE.contacts.high]] },
  conservation: { title: 'Conservación evolutiva', icon: 'scan-search', legend: [['Baja', MODE_PALETTE.conservation.low], ['Media', MODE_PALETTE.conservation.medium], ['Alta', MODE_PALETTE.conservation.high]] },
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

export function mockAnnotations(index, residue) {
  const regimes = ['aqueous_folded', 'aqueous_folded', 'aqueous_folded', 'structurally_uncertain', 'membrane'];
  const sec = ['helix', 'sheet', 'coil', 'turn'];
  const domains = ['LDL-receptor class A', 'EGF-like', 'Beta-propeller', 'C-terminal region', 'NA'];
  const topology = ['outside', 'outside', 'outside', 'inside', 'tm_alpha'];
  const qcs = ['very_high_confidence', 'confident', 'confident', 'low_confidence'];
  const frclass = ['neutral', 'minimally_frustrated', 'highly_frustrated'];
  const seed = ((residue?.authSeqId ?? index + 1) * 37 + index * 11) >>> 0;
  return {
    uniprot_domain: domains[seed % domains.length],
    tmbed_topology: topology[seed % topology.length],
    structure_qc_status: qcs[seed % qcs.length],
    structural_regime: regimes[seed % regimes.length],
    residue_energy_value: `${(-3.2 + ((seed * 17) % 6400) / 1000).toFixed(6)} kcal/mol`,
    secondary_structure: sec[seed % sec.length],
    buried_status: seed % 3 === 0 ? 'buried' : 'exposed',
    structural_frustration_fi_singleresidue: (-1.6 + ((seed * 13) % 3000) / 1000).toFixed(3),
    structural_contacts_n_contacts: String(seed % 19),
    alphamissense_mean: ((seed % 8900) / 10000 + 0.05).toFixed(4),
    cadd_phred_mean: (8 + (seed % 2700) / 100).toFixed(4),
    revel_mean: (((seed * 7) % 9800) / 10000).toFixed(4),
    frustraiseq_class: frclass[(seed * 5) % frclass.length],
    consurf_grade: String(1 + (seed % 9)),
    mavedb_position_assayed: seed % 4 === 0 ? 'true' : 'false',
  };
}

export function modeColor(index, mode, residue) {
  const m = mockAnnotations(index, residue);
  const p = MODE_PALETTE[mode] || MODE_PALETTE.regime;
  if (mode === 'regime') return m.structural_regime === 'membrane' ? p.membrane : m.structural_regime === 'structurally_uncertain' ? p.uncertain : p.folded;
  if (mode === 'frustration') return Number(m.structural_frustration_fi_singleresidue) < -0.8 ? p.high : Number(m.structural_frustration_fi_singleresidue) > 0.55 ? p.minimal : p.neutral;
  if (mode === 'contacts') return Number(m.structural_contacts_n_contacts) >= 12 ? p.high : Number(m.structural_contacts_n_contacts) >= 6 ? p.medium : p.low;
  const grade = Number(m.consurf_grade);
  return grade >= 7 ? p.high : grade >= 4 ? p.medium : p.low;
}

export function readableValue(key, value) {
  const text = String(value ?? 'NA');
  if (key === 'structural_contacts_n_contacts') return `${text} contactos`;
  if (key === 'consurf_grade') return `${text} / 9`;
  if (key === 'cadd_phred_mean') return `${text} PHRED`;
  return VALUE_LABELS[text] || text;
}
