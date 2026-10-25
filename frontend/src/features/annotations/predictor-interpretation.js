const PREDICTOR_SCORE_FIELDS = Object.freeze({
  alphamissense: ['alphamissense', 'alphamissense_score', 'alphamissense_pathogenicity', 'am_pathogenicity'],
  cadd: ['cadd_phred', 'cadd_phred_score', 'cadd_phred_scaled'],
  revel: ['revel', 'revel_score'],
});

function scoreFrom(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (value === null || value === undefined || String(value).trim() === '' || String(value).toUpperCase() === 'NA') continue;
    const score = Number(value);
    if (Number.isFinite(score)) return score;
  }
  return null;
}

function classFrom(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function alphaMissenseResult(record) {
  const score = scoreFrom(record, PREDICTOR_SCORE_FIELDS.alphamissense);
  const sourceClass = classFrom(record?.alphamissense_pred ?? record?.alphamissense_class ?? record?.am_class);
  let tone = 'indeterminate';
  let label = 'Sin interpretación';

  if (score !== null) {
    if (score < 0.34) {
      tone = 'benign';
      label = 'Posiblemente benigna';
    } else if (score > 0.564) {
      tone = 'pathogenic';
      label = 'Posiblemente patogénica';
    } else {
      tone = 'uncertain';
      label = 'Interpretación incierta';
    }
  } else if (['likely_benign', 'benign', 'lben'].includes(sourceClass)) {
    tone = 'benign';
    label = 'Posiblemente benigna';
  } else if (['likely_pathogenic', 'pathogenic', 'lpath'].includes(sourceClass)) {
    tone = 'pathogenic';
    label = 'Posiblemente patogénica';
  } else if (['ambiguous', 'uncertain', 'uncertain_significance'].includes(sourceClass)) {
    tone = 'uncertain';
    label = 'Interpretación incierta';
  }

  return result('AlphaMissense', score, label, tone);
}

function caddResult(record) {
  const score = scoreFrom(record, PREDICTOR_SCORE_FIELDS.cadd);
  if (score === null) return result('CADD', null, 'Sin interpretación', 'indeterminate');

  if (score <= 0.15) return result('CADD', score, 'Evidencia fuerte de benignidad', 'benign');
  if (score <= 17.3) return result('CADD', score, 'Evidencia moderada de benignidad', 'benign');
  if (score <= 22.7) return result('CADD', score, 'Evidencia de benignidad de apoyo', 'benign');
  if (score < 25.3) return result('CADD', score, 'Sin evidencia calibrada', 'uncertain');
  if (score < 28.1) return result('CADD', score, 'Evidencia de patogenicidad de apoyo', 'pathogenic');
  return result('CADD', score, 'Evidencia moderada de patogenicidad', 'pathogenic');
}

function revelResult(record) {
  const score = scoreFrom(record, PREDICTOR_SCORE_FIELDS.revel);
  if (score === null) return result('REVEL', null, 'Sin interpretación', 'indeterminate');

  if (score <= 0.003) return result('REVEL', score, 'Evidencia muy fuerte de benignidad', 'benign');
  if (score <= 0.016) return result('REVEL', score, 'Evidencia fuerte de benignidad', 'benign');
  if (score <= 0.183) return result('REVEL', score, 'Evidencia moderada de benignidad', 'benign');
  if (score <= 0.29) return result('REVEL', score, 'Evidencia de benignidad de apoyo', 'benign');
  if (score < 0.644) return result('REVEL', score, 'Sin evidencia calibrada', 'uncertain');
  if (score < 0.773) return result('REVEL', score, 'Evidencia de patogenicidad de apoyo', 'pathogenic');
  if (score < 0.932) return result('REVEL', score, 'Evidencia moderada de patogenicidad', 'pathogenic');
  return result('REVEL', score, 'Evidencia fuerte de patogenicidad', 'pathogenic');
}

function result(model, score, label, tone) {
  const scoreText = score === null ? null : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 }).format(score);
  const scoreSuffix = scoreText === null ? '' : ` ${scoreText}${model === 'AlphaMissense' || model === 'REVEL' ? '/1' : ''}`;
  let interpretation;

  if (tone === 'benign') {
    interpretation = model === 'AlphaMissense'
      ? 'posiblemente benigna'
      : `evidencia ${evidenceStrength(label)} a favor de benignidad`;
  } else if (tone === 'pathogenic') {
    interpretation = model === 'AlphaMissense'
      ? 'posiblemente patogénica'
      : `evidencia ${evidenceStrength(label)} a favor de un posible efecto perjudicial`;
  } else if (tone === 'uncertain') {
    interpretation = model === 'AlphaMissense'
      ? 'no distingue claramente entre un efecto benigno o perjudicial'
      : 'no orienta claramente hacia benignidad o efecto perjudicial';
  } else {
    interpretation = 'sin puntuación interpretable';
  }

  const direction = scoreText === null
    ? ''
    : model === 'CADD'
      ? ' Valores más altos indican mayor impacto perjudicial predicho.'
      : ' Valores más altos indican mayor probabilidad de efecto perjudicial.';
  const tooltip = `${model}${scoreSuffix}: ${interpretation}.${direction}`;

  return {
    model,
    score,
    scoreText,
    label,
    tone,
    tooltip,
  };
}

function evidenceStrength(label) {
  if (label.includes('muy fuerte')) return 'muy fuerte';
  if (label.includes('fuerte')) return 'fuerte';
  if (label.includes('moderada')) return 'moderada';
  return 'de apoyo';
}

export function predictorVariantLabel(record, fallbackPosition) {
  const explicit = String(record?.variant_id ?? record?.variant ?? '').trim().toUpperCase();
  const position = Number(record?.aa_position ?? record?.position ?? fallbackPosition);
  const reference = String(record?.aa_ref ?? record?.ref_aa ?? '').trim().toUpperCase();
  const alternate = String(record?.aa_alt ?? record?.alt_aa ?? '').trim().toUpperCase();
  if (Number.isInteger(position) && position > 0 && /^[A-Z]$/.test(reference) && /^[A-Z]$/.test(alternate)) {
    return `${reference}${position}${alternate}`;
  }
  const proteinVariant = explicit.match(/^(?:P\.)?([A-Z])(\d+)([A-Z])$/);
  if (proteinVariant) return `${proteinVariant[1]}${proteinVariant[2]}${proteinVariant[3]}`;
  return Number.isInteger(position) && position > 0 ? `Posición ${position}` : `Posición ${fallbackPosition}`;
}

export function groupPredictorSubstitutions(records, fallbackPosition) {
  const groups = new Map();
  records.forEach((record, index) => {
    const label = predictorVariantLabel(record, fallbackPosition);
    const groupKey = /^[A-Z]\d+[A-Z]$/.test(label) ? label : `${label}-${index}`;
    const group = groups.get(groupKey) ?? { label, records: [] };
    group.records.push(record);
    groups.set(groupKey, group);
  });

  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: group.label,
    scores: group.records.length === 1
      ? interpretPredictorSubstitution(group.records[0])
      : combinePredictorScores(group.label, group.records),
  }));
}

function combinePredictorScores(variantLabel, records) {
  const interpretations = records.map(interpretPredictorSubstitution);
  return interpretations[0].map((first, index) => {
    const entries = interpretations.map((row) => row[index]);
    const numericScores = entries.map((entry) => entry.score).filter((score) => score !== null);
    const uniqueScores = [...new Set(numericScores)].sort((left, right) => left - right);
    const scoreText = uniqueScores.length === 0
      ? null
      : uniqueScores.length === 1
        ? formatScore(uniqueScores[0])
        : `${formatScore(uniqueScores[0])}–${formatScore(uniqueScores.at(-1))}`;
    const informative = entries.filter((entry) => entry.tone !== 'indeterminate');
    const tones = [...new Set(informative.map((entry) => entry.tone))];
    const labels = [...new Set(informative.map((entry) => entry.label))];
    const tone = tones.length > 1 ? 'uncertain' : tones[0] ?? 'indeterminate';
    const label = tones.length > 1
      ? 'Resultados discordantes'
      : labels.length > 1
        ? `Evidencia variable de ${tone === 'benign' ? 'benignidad' : 'patogenicidad'}`
        : labels[0] ?? 'Sin interpretación';
    const model = first.model;
    const scoreSuffix = scoreText === null ? '' : ` ${scoreText}${model === 'AlphaMissense' || model === 'REVEL' ? '/1' : ''}`;
    const summary = tones.length > 1
      ? 'Las puntuaciones no coinciden en el posible efecto.'
      : tone === 'benign'
        ? `Apoyan benignidad${labels.length === 1 ? ` con evidencia ${evidenceStrength(labels[0])}` : ''}.`
        : tone === 'pathogenic'
          ? `Apoyan un posible efecto perjudicial${labels.length === 1 ? ` con evidencia ${evidenceStrength(labels[0])}` : ''}.`
          : tone === 'uncertain'
            ? 'No orientan claramente hacia benignidad o efecto perjudicial.'
            : 'No hay puntuación interpretable.';
    const direction = model === 'CADD'
      ? 'Valores más altos indican mayor impacto perjudicial predicho.'
      : 'Valores más altos indican mayor probabilidad de efecto perjudicial.';
    const rangeContext = uniqueScores.length > 1
      ? ` El rango reúne cambios de ADN distintos que producen ${variantLabel}.`
      : '';

    return {
      model,
      score: numericScores[0] ?? null,
      scoreText,
      label,
      tone,
      tooltip: `${model}${scoreSuffix} para ${variantLabel}: ${summary}${rangeContext}${scoreText === null ? '' : ` ${direction}`}`,
    };
  });
}

function formatScore(score) {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 }).format(score);
}

export function interpretPredictorSubstitution(record) {
  return [alphaMissenseResult(record), caddResult(record), revelResult(record)];
}

export function predictorInterpretationTone(score) {
  return score === null ? 'indeterminate' : 'aggregate';
}
