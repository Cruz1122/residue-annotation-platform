function finiteFrustrationValue(value) {
  if (value === null || value === undefined || value === 'NA' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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
  const number = finiteFrustrationValue(value);
  if (number === null) return 'unknown';
  if (number < HIGHLY_FRUSTRATED_CUTOFF) return 'highly_frustrated';
  if (number > minimallyFrustratedCutoff(field)) return 'minimally_frustrated';
  return 'neutral';
}

export function classifyFrustrAISeqIndex(value) {
  const number = finiteFrustrationValue(value);
  if (number === null) return 'unknown';
  if (number < HIGHLY_FRUSTRATED_CUTOFF) return 'highly_frustrated';
  if (number > SRFI_MINIMALLY_FRUSTRATED_CUTOFF) return 'minimally_frustrated';
  return 'neutral';
}

export function frustrationClassLabel(className) {
  return FRUSTRATION_CLASS_INFO[className]?.label ?? FRUSTRATION_CLASS_INFO.unknown.label;
}
