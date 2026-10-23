import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONSERVATION_SCALE,
  conservationEvidenceForResidue,
  conservationProvenance,
  conservationRowsFromArtifact,
  formatConservationGrade,
  formatConservationInterval,
  isValidConservationGrade,
  normalizeConservationGrade,
  publishedConservationMetrics,
} from './conservation-presentation.js';
import { mergeAnnotationRows } from './viewer-presentation.js';

test('ConSurf keeps the published ordinal 1–9 scale', () => {
  assert.deepEqual(CONSERVATION_SCALE.ticks, [1, 3, 5, 7, 9]);
  assert.equal(normalizeConservationGrade('1'), 1);
  assert.equal(normalizeConservationGrade(9), 9);
  assert.equal(isValidConservationGrade(5), true);
  assert.equal(isValidConservationGrade(5.5), false);
  assert.equal(isValidConservationGrade(10), false);
  assert.equal(isValidConservationGrade('NA'), false);
  assert.equal(formatConservationGrade(9), '9 / 9');
  assert.equal(formatConservationGrade(10), '10');
  assert.equal(formatConservationGrade('NA'), 'Sin dato publicado');
});

test('conservation metrics keep Rate4Site separate from ConSurf', () => {
  assert.deepEqual(publishedConservationMetrics({ consurf_grade: 7, rate4site_score: -1.432 }), {
    consurf_grade: 7,
    rate4site_score: -1.432,
  });
  assert.deepEqual(publishedConservationMetrics({ consurf_grade: 'NA', rate4site_score: '' }), {});
});

test('artifact rows preserve published values and omit missing rows', () => {
  const rows = conservationRowsFromArtifact([
    { aa_position: 4, aa_ref: 'E', consurf_grade: '8', rate4site_score: '-1.2', rate4site_score_unit: 'score' },
    { aa_position: 5, aa_ref: 'F', consurf_grade: 'NA', rate4site_score: 'NA' },
    { aa_position: 6, aa_ref: 'G', consurf_grade: '10', rate4site_score: '0.2' },
  ]);

  assert.deepEqual(rows, [
    {
      aa_position: 4,
      aa_ref: 'E',
      stage_id: 'evolutionary_conservation_artifact',
      values: { consurf_grade: '8', rate4site_score: '-1.2' },
      units: { rate4site_score: 'score' },
    },
    {
      aa_position: 6,
      aa_ref: 'G',
      stage_id: 'evolutionary_conservation_artifact',
      values: { consurf_grade: '10', rate4site_score: '0.2' },
      units: {},
    },
  ]);
  assert.equal(normalizeConservationGrade(rows[1].values.consurf_grade), null);
});

test('the published annotation row can supplement an artifact without being overwritten', () => {
  const artifactRows = conservationRowsFromArtifact([
    { aa_position: 4, aa_ref: 'E', consurf_grade: 8, rate4site_score: -1.2 },
  ]);
  const publishedRows = [{
    aa_position: 4,
    aa_ref: 'E',
    values: { consurf_grade: 9 },
    units: {},
    stage_id: 'evolutionary_conservation',
    qc_status: 'verified',
  }];
  const merged = mergeAnnotationRows([...artifactRows, ...publishedRows]).get(4);
  assert.equal(merged.values.consurf_grade, 9);
  assert.equal(merged.values.rate4site_score, -1.2);
});

test('residue evidence exposes only concrete optional fields', () => {
  const evidence = conservationEvidenceForResidue(
    { values: { consurf_grade: 8, rate4site_score: -1.2 }, units: { rate4site_score: 'score' } },
    { ci_low: 7, ci_high: 9, reliable: true, nongap: 142 },
  );
  assert.deepEqual(evidence, {
    consurfGrade: 8,
    rate4siteScore: -1.2,
    rate4siteUnit: 'score',
    ciLow: 7,
    ciHigh: 9,
    ciGradeSpan: null,
    reliable: true,
    nongap: 142,
    naReason: null,
    hasPublishedMetric: true,
  });
  assert.equal(formatConservationInterval(7, 9), '7–9');
  assert.equal(formatConservationInterval('NA', null), null);
});

test('provenance does not turn internal identifiers into scientific facts', () => {
  assert.deepEqual(conservationProvenance(
    { method: 'ConSurf', version: '2024.1', internal_id: 'stage-result-1' },
    { remote_provenance: { tool: 'Rate4Site', version: '2.0' }, slurm_job_id: '123' },
  ), [
    { label: 'Método', value: 'ConSurf', key: 'method' },
    { label: 'Versión', value: '2024.1', key: 'version' },
    { label: 'Herramienta', value: 'Rate4Site', key: 'tool' },
    { label: 'Versión', value: '2.0', key: 'version' },
  ]);
});
