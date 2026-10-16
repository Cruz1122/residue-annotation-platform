const STATUS_TEXT = {
  pending: 'Pendiente',
  ready: 'Listo',
  queued: 'En cola',
  running: 'En ejecución',
  success: 'Completado',
  reused: 'Resultado reutilizado',
  failed: 'Falló',
  skipped: 'No aplica',
  cancelled: 'Cancelado',
  cancel_requested: 'Cancelación solicitada',
  disabled: 'Desactivado',
};

export function runPhase(run) {
  const stages = run?.stages ?? [];
  const preparationStatus = run?.preparation?.status;
  const preflightRunning = stages.some((stage) => stage.preflight_status === 'running');
  const submitting = stages.some((stage) => stage.status === 'queued' && !stage.slurm_job_id);
  if (run?.status === 'failed' || (run?.error_message && run?.status !== 'pending')) {
    return { label: 'El análisis falló', detail: run.error_message ?? 'Consulta el stage que reportó el error.', tone: 'failed' };
  }
  if (run?.status === 'cancel_requested') {
    return { label: 'Cancelando el análisis', detail: 'El worker está cerrando los stages activos.', tone: 'waiting' };
  }
  if (run?.status === 'cancelled') {
    return { label: 'El análisis fue cancelado', detail: 'La configuración y los resultados publicados siguen disponibles.', tone: 'waiting' };
  }
  if (run?.status === 'success') {
    return { label: 'El análisis terminó', detail: 'Los resultados disponibles se muestran abajo.', tone: 'success' };
  }
  if (run?.status === 'running' || stages.some((stage) => stage.status === 'running')) {
    return { label: 'Tu análisis está en ejecución', detail: 'El worker observó ejecución real del pipeline.', tone: 'running' };
  }
  if (preflightRunning) {
    return { label: 'Validando tu proteína', detail: 'Se están comprobando la secuencia, la estructura y los prerrequisitos del análisis.', tone: 'waiting' };
  }
  if (submitting) {
    return { label: 'Enviando el análisis', detail: 'El worker reservó el stage y está confirmando el envío al ejecutor.', tone: 'waiting' };
  }
  if (stages.some((stage) => stage.status === 'queued')) {
    return { label: 'Esperando recursos de cómputo', detail: 'El job fue enviado y todavía espera que Slurm lo ejecute.', tone: 'waiting' };
  }
  if (preparationStatus === 'blocked') {
    return { label: 'Preparación pendiente', detail: run.preparation?.error_message ?? 'Falta un prerrequisito operativo.', tone: 'failed' };
  }
  if (preparationStatus === 'failed') {
    return { label: 'No se pudo preparar el análisis', detail: run.preparation?.error_message ?? 'La validación previa falló.', tone: 'failed' };
  }
  if (preparationStatus === 'running') {
    return { label: 'Preparando los datos científicos', detail: 'Se están validando los prerrequisitos antes del envío.', tone: 'waiting' };
  }
  if (run?.status === 'pending') {
    return { label: 'Preparando el análisis', detail: 'La corrida está confirmada y espera al worker.', tone: 'waiting' };
  }
  return { label: STATUS_TEXT[run?.status] ?? run?.status ?? 'Estado desconocido', detail: '', tone: 'waiting' };
}

export function formatWaitTime(milliseconds) {
  const seconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds / 1000))
    : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
