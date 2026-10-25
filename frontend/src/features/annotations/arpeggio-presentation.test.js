import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARPEGGIO_ROLE_COLORS,
  ARPEGGIO_SCALE_COLORS,
  aggregateContactRows,
  buildArpeggioModel,
  buildArpeggioRoleColors,
  buildArpeggioSummaryRows,
  contactTypeLabel,
  formatArpeggioDistance,
  isContactType,
  normalizeContactRows,
  normalizeSummaryRecord,
  observedContactTypes,
  parseContactTypeList,
} from './arpeggio-presentation.js';

const SEQUENCE = Array.from({ length: 126 }, (_, index) => {
  if (index === 78) return 'R';
  if (index === 125) return 'M';
  return 'A';
}).join('');

function summaryRow(position, aa, contacts, partners, types, clash = 0) {
  return {
    protein_id: 'P02649',
    aa_position: position,
    aa_ref: aa,
    chain: 'A',
    resseq: position,
    icode: 'NA',
    mapping_status: 'exact',
    structural_contacts_n_contacts: String(contacts),
    structural_contacts_n_partner_residues: String(partners),
    structural_contacts_contact_types: types,
    structural_contacts_n_vdw_clash_partners: String(clash),
    structural_contacts_status: 'ok',
    structural_contacts_qc_reason: 'ok',
  };
}

function contact(position, partner, type, distance) {
  return {
    aa_position_1: position,
    aa_ref_1: 'R',
    chain_1: 'A',
    resseq_1: position,
    icode_1: 'NA',
    atom_1: 'CA',
    aa_position_2: partner,
    aa_ref_2: 'A',
    chain_2: 'A',
    resseq_2: partner,
    icode_2: 'NA',
    atom_2: 'CA',
    distance_A: String(distance),
    interaction_type: type,
    same_residue: 'false',
  };
}

const SUMMARY_RECORDS = [
  summaryRow(1, 'M', 0, 0, 'NA', 0),
  summaryRow(79, 'R', 11, 7, 'hydrophobic,ionic,polar,vdw,weak_polar', 1),
  summaryRow(126, 'M', 17, 10, 'hydrophobic,polar,vdw,weak_polar', 0),
];

const LONG_RECORDS = [
  contact(79, 127, 'ionic', 3.1),
  contact(79, 127, 'polar', 3.1),
  contact(79, 75, 'polar', 3.3),
  contact(79, 75, 'weak_polar', 3.3),
  contact(79, 82, 'hydrophobic', 3.6),
  contact(79, 82, 'polar', 3.6),
  contact(79, 82, 'weak_polar', 3.6),
  contact(79, 81, 'vdw', 2.5),
  contact(79, 130, 'hydrophobic', 4.2),
  contact(79, 77, 'polar', 4.5),
  contact(79, 83, 'polar', 4.8),
  contact(79, 100, 'vdw_clash', 1.9),
  contact(79, 100, 'proximal', 4.9),
  contact(126, 124, 'polar', 3.0),
  contact(126, 124, 'vdw', 3.0),
  contact(126, 51, 'hydrophobic', 3.1),
  contact(126, 130, 'polar', 3.2),
  contact(126, 130, 'vdw', 3.2),
  contact(126, 129, 'polar', 3.3),
  contact(126, 129, 'weak_polar', 3.3),
  contact(126, 123, 'polar', 3.4),
  contact(126, 123, 'vdw', 3.4),
  contact(126, 123, 'weak_polar', 3.4),
  contact(126, 82, 'hydrophobic', 3.5),
  contact(126, 122, 'hydrophobic', 3.6),
  contact(126, 122, 'polar', 3.6),
  contact(126, 122, 'weak_polar', 3.6),
  contact(126, 166, 'hydrophobic', 3.7),
  contact(126, 85, 'hydrophobic', 3.8),
  contact(126, 48, 'hydrophobic', 3.9),
];

function model(overrides = {}) {
  return buildArpeggioModel({
    summaryRows: buildArpeggioSummaryRows({ summaryRecords: SUMMARY_RECORDS }),
    contactRows: normalizeContactRows(LONG_RECORDS),
    sequence: SEQUENCE,
    metric: 'contacts',
    selectedTypes: null,
    selectedPosition: 79,
    provenance: { parameters: { interacting_A: 5, ph: 7.4 } },
    ...overrides,
  });
}

test('parses only published contact flags and excludes distance/steric categories', () => {
  assert.deepEqual(parseContactTypeList('polar, vdw_clash, hbond, proximal, weak_polar'), ['hbond', 'polar', 'weak_polar']);
  assert.equal(isContactType('vdw_clash'), false);
  assert.equal(isContactType('proximal'), false);
  assert.equal(isContactType('polar'), true);
  assert.match(contactTypeLabel('weak_polar'), /débil/i);
});

test('normalizes a summary-only annotation row without turning NA into zero', () => {
  const annotation = {
    aa_position: 5,
    aa_ref: 'A',
    values: {
      structural_contacts_n_contacts: 'NA',
      structural_contacts_n_partner_residues: '0',
      structural_contacts_contact_types: 'NA',
      structural_contacts_status: 'ok',
    },
    qc_status: 'verified',
  };
  const rows = buildArpeggioSummaryRows({ annotationByPosition: new Map([[5, annotation]]) });
  assert.equal(rows.get(5).totalContacts, null);
  assert.equal(rows.get(5).partnerCount, 0);
  assert.equal(rows.get(5).published, true);
});

test('aggregates partner/type contacts exactly like the published summary', () => {
  const contactRows = normalizeContactRows(LONG_RECORDS);
  const byPosition = aggregateContactRows(contactRows, null);
  assert.equal(byPosition.get(79).contacts.size, 11);
  assert.equal(byPosition.get(79).partners.size, 7);
  assert.deepEqual([...byPosition.get(79).types].sort(), ['hydrophobic', 'ionic', 'polar', 'vdw', 'weak_polar']);
  assert.equal(byPosition.get(126).contacts.size, 17);
  assert.equal(byPosition.get(126).partners.size, 10);
});

test('published zero is coloured while a missing residue stays neutral', () => {
  const view = model();
  const zero = view.sequenceRows.find((row) => row.position === 1);
  const missing = view.sequenceRows.find((row) => row.position === 2);
  assert.equal(zero.published, true);
  assert.equal(zero.value, 0);
  assert.equal(zero.color, ARPEGGIO_SCALE_COLORS[0]);
  assert.equal(missing.published, false);
  assert.equal(missing.color, null);
});

test('selected residue uses filtered counts, partner evidence and a scientific scale', () => {
  const view = model();
  assert.equal(view.hasPublishedRows, true);
  assert.equal(view.hasDetailedContacts, true);
  assert.equal(view.selected.value, 11);
  assert.equal(view.selected.filteredContactCount, 11);
  assert.equal(view.selected.filteredPartnerCount, 7);
  assert.equal(view.partners.length, 7);
  assert.equal(view.partners[0].position, 81);
  assert.equal(view.partners[0].primaryType, 'vdw');
  assert.equal(view.overlayContacts.length, 7);
  assert.equal(formatArpeggioDistance(view.partners[0].minDistance), '2.5 Å');
  assert.match(view.scale.methodLabel, /radio de búsqueda 5 Å/);
  assert.match(view.scale.methodLabel, /pH 7\.4/);
  assert.equal(view.scale.note, 'Conteo entero por residuo');
  assert.equal(view.scale.sourceUrl, 'https://doi.org/10.1016/j.jmb.2016.12.004');
});

test('uses precomputed contact aggregates without changing the selected-residue model', () => {
  const summaryRows = buildArpeggioSummaryRows({ summaryRecords: SUMMARY_RECORDS });
  const contactRows = normalizeContactRows(LONG_RECORDS);
  const observedTypes = observedContactTypes(summaryRows, contactRows);
  const allDetailByPosition = aggregateContactRows(contactRows);
  const filteredDetailByPosition = aggregateContactRows(contactRows, new Set(['hydrophobic', 'polar']));
  const options = {
    summaryRows,
    contactRows,
    sequence: SEQUENCE,
    metric: 'partners',
    selectedTypes: new Set(['hydrophobic', 'polar']),
    selectedPosition: 79,
    provenance: { parameters: { interacting_A: 5, ph: 7.4 } },
  };

  assert.deepEqual(
    buildArpeggioModel(options),
    buildArpeggioModel({
      ...options,
      allDetailByPosition,
      filteredDetailByPosition,
      knownObservedTypes: observedTypes,
    }),
  );
});

test('metric dropdown changes panel values and sequence colours', () => {
  const contacts = model({ metric: 'contacts' });
  const partners = model({ metric: 'partners' });
  assert.equal(contacts.selected.value, 11);
  assert.equal(partners.selected.value, 7);
  assert.notEqual(contacts.selected.color, partners.selected.color);
  assert.notEqual(
    contacts.sequenceRows.find((row) => row.position === 79).color,
    partners.sequenceRows.find((row) => row.position === 79).color,
  );
  assert.equal(contacts.scale.label, 'Contactos');
  assert.equal(partners.scale.label, 'Residuos asociados');
});

test('contact-type checklist filters partners, overlay, counts and colours', () => {
  const all = model();
  const hydrophobic = model({ selectedTypes: new Set(['hydrophobic']) });
  const none = model({ selectedTypes: new Set() });
  assert.equal(hydrophobic.selected.value, 2);
  assert.equal(hydrophobic.selected.filteredPartnerCount, 2);
  assert.deepEqual(hydrophobic.partners.map((partner) => partner.position).sort((a, b) => a - b), [82, 130]);
  assert.equal(hydrophobic.overlayContacts.length, 2);
  assert.notEqual(all.selected.color, hydrophobic.selected.color);
  assert.equal(none.selected.value, 0);
  assert.equal(none.partners.length, 0);
  assert.equal(none.overlayContacts.length, 0);
  assert.equal(none.allZero, true);
  assert.equal(none.scale.filteredEmpty, true);
  assert.equal(none.scale.publishedAllZero, false);
});

test('summary-only run hides detail and falls back to published counts', () => {
  const view = model({ contactRows: [] });
  assert.equal(view.hasDetailedContacts, false);
  assert.equal(view.hasPublishedRows, true);
  assert.equal(view.selected.detailAvailable, false);
  assert.equal(view.selected.value, 11);
  assert.deepEqual(view.partners, []);
  assert.deepEqual(view.overlayContacts, []);
});

test('a detail/summary mismatch is not presented as detailed evidence', () => {
  const mismatched = LONG_RECORDS.filter((row) => !(row.aa_position_1 === 79 && row.interaction_type === 'ionic'));
  const view = model({ contactRows: normalizeContactRows(mismatched) });
  assert.equal(view.selected.detailAvailable, false);
  assert.equal(view.selected.value, 11);
  assert.deepEqual(view.partners, []);
  assert.deepEqual(view.overlayContacts, []);
});

test('NA chain and residue numbering do not become a fake structure key', () => {
  const row = normalizeSummaryRecord({
    aa_position: 5,
    aa_ref: 'A',
    chain: 'NA',
    resseq: 'NA',
    icode: 'NA',
    structural_contacts_n_contacts: '2',
    structural_contacts_n_partner_residues: '1',
    structural_contacts_contact_types: 'polar',
    structural_contacts_status: 'ok',
  });
  assert.equal(row.chain, '');
  assert.equal(row.resseq, '');
  assert.equal(row.structureKey, '');
});

test('role colours require a matched reference and distinguish published zero from missing', () => {
  const matchedZero = buildArpeggioRoleColors({
    referenceMatched: true,
    selectedStructureKey: 'A|1|',
    selectedColor: ARPEGGIO_SCALE_COLORS[0],
    selectedPublished: true,
    partners: [{ structureKey: 'A|2|' }, { structureKey: 'A|4|', color: '#b97812' }],
  });
  assert.equal(matchedZero.get('A|1|'), ARPEGGIO_SCALE_COLORS[0]);
  assert.equal(matchedZero.get('A|2|'), ARPEGGIO_ROLE_COLORS.partner);
  assert.equal(matchedZero.get('A|4|'), '#b97812');

  const missing = buildArpeggioRoleColors({
    referenceMatched: true,
    selectedStructureKey: 'A|3|',
    selectedColor: null,
    selectedPublished: false,
  });
  assert.equal(missing.get('A|3|'), ARPEGGIO_ROLE_COLORS.selectedMissing);

  const unmatched = buildArpeggioRoleColors({
    referenceMatched: false,
    selectedStructureKey: 'A|1|',
    selectedColor: ARPEGGIO_SCALE_COLORS[0],
    selectedPublished: true,
    partners: [{ structureKey: 'A|2|' }],
  });
  assert.equal(unmatched.size, 0);
});

test('published zero stays published while a missing selected residue stays missing', () => {
  const summaryRows = buildArpeggioSummaryRows({
    summaryRecords: [summaryRow(1, 'M', 0, 0, 'NA', 0)],
  });
  const publishedZero = buildArpeggioModel({
    summaryRows,
    contactRows: [],
    sequence: SEQUENCE,
    selectedPosition: 1,
  });
  assert.equal(publishedZero.selected.published, true);
  assert.equal(publishedZero.selected.value, 0);
  assert.equal(publishedZero.selected.color, ARPEGGIO_SCALE_COLORS[0]);
  assert.equal(publishedZero.scale.filteredEmpty, false);
  assert.equal(publishedZero.scale.publishedAllZero, true);

  const missing = buildArpeggioModel({
    summaryRows,
    contactRows: [],
    sequence: SEQUENCE,
    selectedPosition: 2,
  });
  assert.equal(missing.selected.published, false);
  assert.equal(missing.selected.value, null);
  assert.equal(missing.selected.color, null);
});

test('no published rows yields the explicit no-data model', () => {
  const view = buildArpeggioModel({
    summaryRows: new Map(),
    contactRows: [],
    sequence: SEQUENCE,
  });
  assert.equal(view.hasPublishedRows, false);
  assert.equal(view.hasDetailedContacts, false);
  assert.equal(view.autoSelectPosition, null);
  assert.equal(view.selected, null);
});
