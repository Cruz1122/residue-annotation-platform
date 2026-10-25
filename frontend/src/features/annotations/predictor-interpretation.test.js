import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPredictorSubstitutions, interpretPredictorSubstitution, predictorVariantLabel } from './predictor-interpretation.js';

function byModel(record) {
  return Object.fromEntries(interpretPredictorSubstitution(record).map((result) => [result.model, result]));
}

test('AlphaMissense classifies individual substitutions at the published boundaries', () => {
  assert.equal(byModel({ alphamissense: 0.339 }).AlphaMissense.tone, 'benign');
  assert.equal(byModel({ alphamissense: 0.34 }).AlphaMissense.tone, 'uncertain');
  assert.equal(byModel({ alphamissense: 0.564 }).AlphaMissense.tone, 'uncertain');
  assert.equal(byModel({ alphamissense: 0.565 }).AlphaMissense.label, 'Posiblemente patogénica');
  assert.equal(byModel({ alphamissense_mean: 0.9 }).AlphaMissense.label, 'Sin interpretación');
});

test('CADD and REVEL use variant-level calibrated evidence intervals, not positional means', () => {
  assert.equal(byModel({ cadd_phred: 0.15 }).CADD.label, 'Evidencia fuerte de benignidad');
  assert.equal(byModel({ cadd_phred: 24 }).CADD.label, 'Sin evidencia calibrada');
  assert.equal(byModel({ cadd_phred: 28.1 }).CADD.label, 'Evidencia moderada de patogenicidad');
  assert.equal(byModel({ cadd_phred_mean: 35 }).CADD.label, 'Sin interpretación');
  assert.equal(byModel({ revel: 0.29 }).REVEL.tone, 'benign');
  assert.equal(byModel({ revel: 0.5 }).REVEL.label, 'Sin evidencia calibrada');
  assert.equal(byModel({ revel: 0.932 }).REVEL.label, 'Evidencia fuerte de patogenicidad');
  assert.equal(byModel({ revel_mean: 0.99 }).REVEL.label, 'Sin interpretación');
});

test('predictor substitutions expose a readable protein variant identifier', () => {
  assert.equal(predictorVariantLabel({ aa_ref: 'F', aa_alt: 'L', aa_position: 402 }), 'F402L');
  assert.equal(predictorVariantLabel({ variant_id: 'f402l' }, 402), 'F402L');
  assert.equal(predictorVariantLabel({ variant_id: 'p.K90E', refcodon: 'AAA', altcodon: 'GAA' }, 90), 'K90E');
  assert.equal(predictorVariantLabel({ aa_ref: 'K', aa_alt: 'E', aa_position: 90, chrom: '19', pos: 44908564, ref: 'A', alt: 'G' }, 90), 'K90E');
  assert.equal(predictorVariantLabel({ chrom: '19', pos: 44908564, ref: 'A', alt: 'G' }, 90), 'Posición 90');
});

test('predictor tooltips orient in plain language without exposing calibration thresholds', () => {
  const alpha = byModel({ alphamissense: 0.7 }).AlphaMissense;
  const cadd = byModel({ cadd_phred: 30 }).CADD;
  const revel = byModel({ revel: 0.95 }).REVEL;
  assert.match(alpha.tooltip, /0,7\/1: posiblemente patogénica/i);
  assert.match(alpha.tooltip, /valores más altos indican mayor probabilidad de efecto perjudicial/i);
  assert.match(cadd.tooltip, /evidencia moderada a favor de un posible efecto perjudicial/i);
  assert.match(revel.tooltip, /evidencia fuerte a favor de un posible efecto perjudicial/i);
  for (const interpretation of [alpha, cadd, revel]) {
    assert.doesNotMatch(interpretation.tooltip, /PP3|BP4|≤|≥|calibrad[oa]|clasificación clínica/i);
  }
});

test('protein-identical substitutions are grouped without showing nucleotide coordinates', () => {
  const rows = groupPredictorSubstitutions([
    { aa_ref: 'K', aa_alt: 'N', aa_position: 90, chrom: '19', pos: 44908564, ref: 'A', alt: 'G', alphamissense: 0.434, cadd_phred: 14.67, revel: 0.047 },
    { aa_ref: 'K', aa_alt: 'N', aa_position: 90, chrom: '19', pos: 44908565, ref: 'C', alt: 'T', alphamissense: 0.434, cadd_phred: 14.69, revel: 0.047 },
  ], 90);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'K90N');
  assert.equal(rows[0].scores.find((score) => score.model === 'CADD').scoreText, '14,67–14,69');
  assert.match(rows[0].scores.find((score) => score.model === 'CADD').tooltip, /para K90N/);
  assert.match(rows[0].scores.find((score) => score.model === 'CADD').tooltip, /rango reúne cambios de ADN distintos que producen K90N/i);
  assert.doesNotMatch(rows[0].scores.find((score) => score.model === 'CADD').tooltip, /19:44908/);
});

test('grouped substitutions show discordance when predictor interpretations differ', () => {
  const [row] = groupPredictorSubstitutions([
    { aa_ref: 'K', aa_alt: 'E', aa_position: 90, cadd_phred: 24 },
    { aa_ref: 'K', aa_alt: 'E', aa_position: 90, cadd_phred: 29 },
  ], 90);
  const cadd = row.scores.find((score) => score.model === 'CADD');

  assert.equal(row.label, 'K90E');
  assert.equal(cadd.tone, 'uncertain');
  assert.equal(cadd.label, 'Resultados discordantes');
  assert.match(cadd.tooltip, /no coinciden en el posible efecto/i);
});
