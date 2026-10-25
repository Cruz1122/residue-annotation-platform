function structureNames(source) {
  if (typeof source === 'string') return [source];
  if (!source || typeof source !== 'object') return [];
  return [
    source.artifact_type,
    source.download_filename,
    source.original_filename,
    source.filename,
    source.display_name,
    source.name,
  ].filter((value) => typeof value === 'string' && value.trim());
}

function mediaTypeFor(source, mediaType) {
  return String(mediaType ?? source?.media_type ?? '').toLowerCase();
}

function hasCifName(names) {
  return names.some((name) => /(?:^|[._\s-])(?:cif|mmcif)$/i.test(name.trim()));
}

function hasPdbName(names) {
  return names.some((name) => /(?:^|[._\s-])pdb$/i.test(name.trim()));
}

export function structureFormat(source, mediaType) {
  const names = structureNames(source);
  const media = mediaTypeFor(source, mediaType);
  return media.includes('cif') || hasCifName(names) ? 'mmcif' : 'pdb';
}

export function isStructureArtifact(source, mediaType) {
  const names = structureNames(source);
  const media = mediaTypeFor(source, mediaType);
  return names.some((name) => /\.(?:pdb|cif|mmcif)$/i.test(name.trim()))
    || hasCifName(names)
    || hasPdbName(names)
    || media.includes('pdb')
    || media.includes('cif');
}
