import {
  colorOnScale,
  finiteAnnotationValue,
  normalizeValue,
} from './viewer-presentation.js';
import {
  classifyFrustrAISeqIndex,
  classifyFrustratometerValue,
  FRUSTRATION_CLASS_INFO,
  normalizeFrustrationClass,
  SRFI_MINIMALLY_FRUSTRATED_CUTOFF,
} from './frustration-classification.js';

export {
  classifyFrustrAISeqIndex,
  classifyFrustratometerValue,
  CONTACT_FI_MINIMALLY_FRUSTRATED_CUTOFF,
  FRUSTRATION_CLASS_INFO,
  frustrationClassLabel,
  HIGHLY_FRUSTRATED_CUTOFF,
  minimallyFrustratedCutoff,
  normalizeFrustrationClass,
  SRFI_MINIMALLY_FRUSTRATED_CUTOFF,
} from './frustration-classification.js';

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
