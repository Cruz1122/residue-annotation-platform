import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFrustratometerValue,
  classifyFrustrAISeqIndex,
  colorForFrustrationMetric,
  CONTACT_FI_MINIMALLY_FRUSTRATED_CUTOFF,
  FRUSTRAISEQ_ENTROPY_DOMAIN,
  FRUSTRAISEQ_SURPRISAL_DOMAIN,
  FRUSTRATION_CLASS_INFO,
  minimallyFrustratedCutoff,
  normalizeFrustrationClass,
  SRFI_MINIMALLY_FRUSTRATED_CUTOFF,
} from './frustration-presentation.js';

test('single-residue FI uses the published -1 and 0.55 cutoffs', () => {
  const field = 'structural_frustration_fi_singleresidue';
  assert.equal(minimallyFrustratedCutoff(field), SRFI_MINIMALLY_FRUSTRATED_CUTOFF);
  assert.equal(classifyFrustratometerValue(-1.01, field), 'highly_frustrated');
  assert.equal(classifyFrustratometerValue(-1, field), 'neutral');
  assert.equal(classifyFrustratometerValue(0.55, field), 'neutral');
  assert.equal(classifyFrustratometerValue(0.551, field), 'minimally_frustrated');
});

test('contact FI uses the published -1 and 0.78 cutoffs', () => {
  const field = 'structural_frustration_fi_configurational';
  assert.equal(minimallyFrustratedCutoff(field), CONTACT_FI_MINIMALLY_FRUSTRATED_CUTOFF);
  assert.equal(classifyFrustratometerValue(-1.2, field), 'highly_frustrated');
  assert.equal(classifyFrustratometerValue(0.78, field), 'neutral');
  assert.equal(classifyFrustratometerValue(0.79, field), 'minimally_frustrated');
});

test('FrustrAI-Seq keeps the published class and uses -1 and 0.55 as index cutoffs', () => {
  assert.equal(normalizeFrustrationClass('Highly frustrated'), 'highly_frustrated');
  assert.equal(normalizeFrustrationClass('MINIMALLY_FRUSTRATED'), 'minimally_frustrated');
  assert.equal(classifyFrustrAISeqIndex(-1.01), 'highly_frustrated');
  assert.equal(classifyFrustrAISeqIndex(-1), 'neutral');
  assert.equal(classifyFrustrAISeqIndex(0.55), 'neutral');
  assert.equal(classifyFrustrAISeqIndex(0.551), 'minimally_frustrated');
  assert.equal(colorForFrustrationMetric({
    value: -2,
    field: 'frustraiseq_index',
    publishedClass: 'minimally_frustrated',
  }), FRUSTRATION_CLASS_INFO.minimally_frustrated.color);
  assert.equal(colorForFrustrationMetric({
    value: 2,
    field: 'frustraiseq_index',
    publishedClass: 'highly_frustrated',
  }), FRUSTRATION_CLASS_INFO.highly_frustrated.color);
  assert.equal(colorForFrustrationMetric({
    value: 0,
    field: 'frustraiseq_index',
    publishedClass: null,
  }), FRUSTRATION_CLASS_INFO.neutral.color);
  assert.equal(colorForFrustrationMetric({
    value: null,
    field: 'frustraiseq_index',
  }), FRUSTRATION_CLASS_INFO.unknown.color);
});

test('missing values remain visually missing', () => {
  assert.equal(classifyFrustratometerValue('NA', 'structural_frustration_fi_singleresidue'), 'unknown');
  assert.equal(colorForFrustrationMetric({
    value: null,
    field: 'frustraiseq_entropy',
    domain: { min: 0, max: 1 },
  }), FRUSTRATION_CLASS_INFO.unknown.color);
});

test('FrustrAI-Seq entropy and surprisal use fixed visual domains', () => {
  assert.deepEqual(FRUSTRAISEQ_ENTROPY_DOMAIN, { min: 0, max: 1 });
  assert.deepEqual(FRUSTRAISEQ_SURPRISAL_DOMAIN, { min: -3, max: 3 });
  assert.equal(colorForFrustrationMetric({
    value: 0,
    field: 'frustraiseq_entropy',
    domain: { min: 0.4, max: 0.6 },
  }), '#e8edf5');
  assert.equal(colorForFrustrationMetric({
    value: -3,
    field: 'frustraiseq_surprisal',
    domain: { min: -0.1, max: 0.1 },
  }), '#2f67bd');
  assert.equal(colorForFrustrationMetric({
    value: 3,
    field: 'frustraiseq_surprisal',
    domain: { min: -0.1, max: 0.1 },
  }), '#c9362b');
});
