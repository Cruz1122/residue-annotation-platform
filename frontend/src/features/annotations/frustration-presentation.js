import {
  colorOnScale,
  finiteAnnotationValue,
  normalizeValue,
} from './viewer-presentation.js';

export const HIGHLY_FRUSTRATED_CUTOFF = -1;
export const SRFI_MINIMALLY_FRUSTRATED_CUTOFF = 0.55;
export const CONTACT_FI_MINIMALLY_FRUSTRATED_CUTOFF = 0.78;

export const FRUSTRATION_CLASS_INFO = {
  highly_frustrated: {
    label: 'Altamente frustrado',
    color: '#c9362b',
  },
  neutral: {
    label: 'Neutral',
    color: '#c8ced2',
  },
  minimally_frustrated: {
    label: 'Mínimamente frustrado',
    color: '#278867',
  },
  unknown: {
    label: 'Sin clase publicada',
    color: '#b8bec5',
  },
};

export const DESCRIPTIVE_SEQUENCE_COLORS = ['#e8edf5', '#8f79c6', '#40206f'];
export const FRUSTRAISEQ_ENTROPY_DOMAIN = { min: 0, max: 1 };
export const FRUSTRAISEQ_SURPRISAL_DOMAIN = { min: -3, max: 3 };
export const FRUSTRAISEQ_ENTROPY_COLORS = DESCRIPTIVE_SEQUENCE_COLORS;
export const FRUSTRAISEQ_SURPRISAL_COLORS = ['#2f67bd', '#e8edf5', '#c9362b'];
export const FRUSTRAISEQ_INDEX_COLORS = [
  FRUSTRATION_CLASS_INFO.highly_frustrated.color,
  FRUSTRATION_CLASS_INFO.neutral.color,
  FRUSTRATION_CLASS_INFO.minimally_frustrated.color,
];
export const FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF = SRFI_MINIMALLY_FRUSTRATED_CUTOFF;

export function normalizeFrustrationClass(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['high', 'highly', 'highly_frustrated', 'highlyfrustrated'].includes(normalized)) {
    return 'highly_frustrated';
  }
  if (['minimal', 'minimally', 'minimally_frustrated', 'minimallyfrustrated'].includes(normalized)) {
    return 'minimally_frustrated';
  }
  if (['neutral', 'neutrally_frustrated', 'neutrallyfrustrated'].includes(normalized)) {
    return 'neutral';
  }
  return 'unknown';
}

export function minimallyFrustratedCutoff(field) {
  return field === 'structural_frustration_fi_singleresidue'
    ? SRFI_MINIMALLY_FRUSTRATED_CUTOFF
    : CONTACT_FI_MINIMALLY_FRUSTRATED_CUTOFF;
}

export function classifyFrustratometerValue(value, field) {
  const number = finiteAnnotationValue(value);
  if (number === null) return 'unknown';
  if (number < HIGHLY_FRUSTRATED_CUTOFF) return 'highly_frustrated';
  if (number > minimallyFrustratedCutoff(field)) return 'minimally_frustrated';
  return 'neutral';
}

export function classifyFrustrAISeqIndex(value) {
  const number = finiteAnnotationValue(value);
  if (number === null) return 'unknown';
  if (number < HIGHLY_FRUSTRATED_CUTOFF) return 'highly_frustrated';
  if (number > FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF) return 'minimally_frustrated';
  return 'neutral';
}

export function frustrationClassLabel(className) {
  return FRUSTRATION_CLASS_INFO[className]?.label ?? FRUSTRATION_CLASS_INFO.unknown.label;
}

export function colorForFrustrationMetric({ value, field, domain, publishedClass }) {
  if (field.startsWith('structural_frustration_')) {
    return FRUSTRATION_CLASS_INFO[classifyFrustratometerValue(value, field)].color;
  }
  if (field === 'frustraiseq_index') {
    const publishedClassName = normalizeFrustrationClass(publishedClass);
    if (publishedClassName !== 'unknown') return FRUSTRATION_CLASS_INFO[publishedClassName].color;
    const fallbackClassName = classifyFrustrAISeqIndex(value);
    if (fallbackClassName !== 'unknown') return FRUSTRATION_CLASS_INFO[fallbackClassName].color;
    return FRUSTRATION_CLASS_INFO.unknown.color;
  }
  if (field === 'frustraiseq_entropy' || field === 'frustraiseq_surprisal') {
    const number = finiteAnnotationValue(value);
    const fixedDomain = field === 'frustraiseq_entropy'
      ? FRUSTRAISEQ_ENTROPY_DOMAIN
      : FRUSTRAISEQ_SURPRISAL_DOMAIN;
    const colors = field === 'frustraiseq_entropy'
      ? FRUSTRAISEQ_ENTROPY_COLORS
      : FRUSTRAISEQ_SURPRISAL_COLORS;
    if (number === null) return FRUSTRATION_CLASS_INFO.unknown.color;
    return colorOnScale(
      normalizeValue(number, fixedDomain.min, fixedDomain.max),
      colors,
    ) ?? FRUSTRATION_CLASS_INFO.unknown.color;
  }
  return FRUSTRATION_CLASS_INFO.unknown.color;
}
