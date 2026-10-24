export function comparisonChannelSignature(composition) {
  return (composition?.active ?? [])
    .map(({ id, tracks = [] }) => `${id}:${tracks.map(({ id: trackId }) => trackId).join(',')}`)
    .join('|');
}

export function comparisonCameraAction(previousSignature, nextSignature) {
  if (previousSignature === nextSignature) return 'none';
  return 'structure';
}
