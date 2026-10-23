import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactDisplayName,
  artifactDownloadFilename,
  artifactDownloadFormat,
  artifactFormatLabel,
} from './artifact-display.js';

test('presents generated tables with scientific names and Excel downloads', () => {
  const artifact = {
    artifact_type: 'variant_annotations',
    media_type: 'text/tab-separated-values',
  };

  assert.equal(artifactDisplayName(artifact), 'Resultados de ΔΔG por variante');
  assert.equal(artifactFormatLabel(artifact), 'Excel (.xlsx)');
  assert.equal(artifactDownloadFormat(artifact), 'xlsx');
  assert.equal(artifactDownloadFilename(artifact), 'resultados-de-ddg-por-variante.xlsx');
});

test('keeps native JSON artifacts as JSON', () => {
  const artifact = {
    artifact_type: 'selected_reference_json',
    media_type: 'application/json',
  };

  assert.equal(artifactDisplayName(artifact), 'Referencia estructural seleccionada (JSON)');
  assert.equal(artifactFormatLabel(artifact), 'JSON');
  assert.equal(artifactDownloadFormat(artifact), 'original');
  assert.equal(artifactDownloadFilename(artifact), 'referencia-estructural-seleccionada-json.json');
});

test('normalizes unknown backend names instead of exposing snake case', () => {
  assert.equal(
    artifactDisplayName({ artifact_type: 'new_scientific_table', media_type: 'text/plain' }),
    'New Scientific Table',
  );
});

test('sanitizes artifact download names and derives a safe extension', () => {
  const artifact = {
    artifact_type: 'metadata',
    media_type: 'application/json',
    download_filename: '../../Resultados\r\n<script>.exe',
  };

  assert.equal(artifactDownloadFilename(artifact), 'resultados-script.json');
  assert.doesNotMatch(artifactDownloadFilename(artifact), /[\\/\u0000-\u001f\u007f\"]/);
});
