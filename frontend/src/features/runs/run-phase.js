import { runFailureMessage } from '../../shared/lib/error-presentation.ts';

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

function phase(label, detail, tone, presentation = 'banner') {
  return { label, detail, tone, presentation };
}

export function runPhase(run) {
  const stages = run?.stages ?? [];
  const preparationStatus = run?.preparation?.status;
  const preflightRunning = stages.some((stage) => stage.preflight_status === 'running');
  const submitting = stages.some((stage) => stage.status === 'queued' && !stage.slurm_job_id);
  if (run?.status === 'failed' || (run?.error_message && run?.status !== 'pending')) {
    return phase('Corrida fallida', runFailureMessage(run.error_code, run.error_message), 'failed');
  }
  if (run?.status === 'cancel_requested') {
    return phase('Cancelación en curso', 'El worker está cerrando los stages activos.', 'waiting');
  }
  if (run?.status === 'cancelled') {
    return phase('Corrida cancelada', 'La configuración y los resultados publicados siguen disponibles.', 'waiting');
  }
  if (run?.status === 'success') {
    return phase('Corrida completada', 'Los resultados publicados están disponibles.', 'success');
  }
  if (run?.status === 'running' || stages.some((stage) => stage.status === 'running')) {
    const activeStages = stages.filter((stage) => stage.status === 'running').length;
    return phase(
      'Corrida en ejecución',
      activeStages > 0 ? 'Hay stages activos en el pipeline.' : '',
      'running',
    );
  }
  if (preflightRunning) {
    return phase('Validación de prerrequisitos', 'Se comprueban secuencia, estructura y configuración.', 'waiting', 'overlay');
  }
  if (submitting) {
    return phase('Envío al ejecutor', 'El worker está confirmando la ejecución del stage.', 'waiting', 'overlay');
  }
  if (stages.some((stage) => stage.status === 'queued')) {
    return phase('Esperando recursos de cómputo', 'El job está en cola de Slurm.', 'waiting', 'overlay');
  }
  if (preparationStatus === 'blocked') {
    return phase('Preparación pendiente', runFailureMessage(run.preparation?.error_code, run.preparation?.error_message), 'warning', 'overlay');
  }
  if (preparationStatus === 'failed') {
    return phase('Preparación fallida', runFailureMessage(run.preparation?.error_code, run.preparation?.error_message), 'failed', 'overlay');
  }
  if (preparationStatus === 'running') {
    return phase('Preparando datos científicos', 'Se validan los prerrequisitos antes del envío.', 'waiting', 'overlay');
  }
  if (run?.status === 'pending') {
    return phase('Corrida pendiente', 'La configuración está confirmada y espera al worker.', 'waiting', 'overlay');
  }
  return phase(STATUS_TEXT[run?.status] ?? run?.status ?? 'Estado desconocido', '', 'waiting', 'overlay');
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
