function aliasIdentifier(protein, source) {
  return protein?.aliases?.find((alias) => alias.source?.toLowerCase() === source)?.identifier?.trim() || '';
}

function cleanProteinIdentifier(identifier) {
  const value = String(identifier ?? '').trim();
  if (!value) return '';
  const pipeParts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length >= 3) return pipeParts[2];
  return value.replace(/^sp\|[^|]+\|/i, '').trim();
}

const RUN_STATUS_TEXT = {
  pending: 'Pendiente',
  ready: 'Lista',
  queued: 'En cola',
  running: 'En ejecución',
  success: 'Completada',
  reused: 'Completada',
  failed: 'Fallida',
  cancel_requested: 'Cancelando',
  cancelled: 'Cancelada',
};

const RUNNING_STATUSES = new Set(['running', 'cancel_requested']);

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function runStatusLabel(status) {
  return RUN_STATUS_TEXT[status] ?? 'Estado desconocido';
}

export function runDurationText(run, now = Date.now()) {
  if (!run?.started_at) return '';
  const started = new Date(run.started_at).getTime();
  if (!Number.isFinite(started)) return '';

  const finished = run.finished_at ? new Date(run.finished_at).getTime() : NaN;
  const end = RUNNING_STATUSES.has(run.status) ? now : finished;
  if (!Number.isFinite(end) || end < started) return '';

  return RUNNING_STATUSES.has(run.status)
    ? `Lleva ${formatElapsed(end - started)}`
    : `Duró ${formatElapsed(end - started)}`;
}

export function runActivityText(run, now = Date.now()) {
  if (!run) return 'Sin corridas';
  const duration = runDurationText(run, now);
  return duration ? `${runStatusLabel(run.status)} · ${duration}` : runStatusLabel(run.status);
}

export function runStatusClass(status) {
  return RUN_STATUS_TEXT[status] ? status : 'unknown';
}

export function proteinDisplayName(protein) {
  const gene = aliasIdentifier(protein, 'gene');
  if (gene) return gene;

  const preferredAlias = protein?.aliases?.find((alias) => alias.source?.toLowerCase() === 'fasta_header')
    || protein?.aliases?.find((alias) => alias.source?.toLowerCase() === 'uniprot')
    || protein?.aliases?.[0];
  return cleanProteinIdentifier(preferredAlias?.identifier) || 'Proteína sin nombre';
}

export function proteinAccession(protein, run = null) {
  const configuredAccession = String(run?.configuration?.scientific_accession ?? '').trim();
  if (configuredAccession) return configuredAccession;

  const aliases = protein?.aliases ?? [];
  const accessionAlias = aliases.find((alias) =>
    ['uniprot', 'uniprot_accession', 'accession'].includes(alias.source?.toLowerCase()));
  const accessionFromHeader = (identifier) => identifier?.match(/(?:^|[>\s])(?:sp|tr)\|([^|]+)\|/i)?.[1] ?? '';
  if (accessionAlias?.identifier?.trim()) {
    return accessionFromHeader(accessionAlias.identifier) || accessionAlias.identifier.trim();
  }

  const fastaHeader = aliases.find((alias) => alias.source?.toLowerCase() === 'fasta_header')?.identifier?.trim();
  const accession = accessionFromHeader(fastaHeader);
  if (accession) return accession;

  return 'Accession no disponible';
}

export function proteinSearchValues(protein, run = null) {
  const accession = proteinAccession(protein, run);
  return [
    protein?.id,
    protein?.sequence_sha256,
    proteinDisplayName(protein),
    accession !== 'Accession no disponible' ? accession : '',
    ...(protein?.aliases ?? []).flatMap((alias) => [alias.identifier, cleanProteinIdentifier(alias.identifier)]),
  ].filter(Boolean);
}

export function proteinProgressHref(protein, run = null) {
  const path = `/proteins/${encodeURIComponent(protein?.id ?? '')}/progress/`;
  return run?.id ? `${path}?run=${encodeURIComponent(run.id)}` : path;
}
