const STATUS_MESSAGES: Record<number, string> = {
  0: 'No se pudo conectar con el servicio. Comprueba la conexión e inténtalo de nuevo.',
  400: 'La solicitud no es válida. Revisa los datos enviados.',
  401: 'La sesión ha caducado. Inicia sesión de nuevo.',
  403: 'No tienes permiso para acceder a este recurso.',
  404: 'No se encontró el recurso solicitado.',
  409: 'La operación entra en conflicto con el estado actual.',
  413: 'El archivo supera el tamaño permitido.',
  415: 'El formato del archivo no es compatible.',
  422: 'Hay datos incompletos o no válidos. Revisa la entrada.',
  429: 'Se alcanzó el límite de solicitudes. Espera un momento antes de reintentar.',
  500: 'El servicio encontró un problema interno.',
  501: 'Esta función no está disponible en el navegador actual.',
  502: 'El servicio devolvió una respuesta inesperada.',
  503: 'El servicio no está disponible temporalmente.',
  504: 'El servicio tardó demasiado en responder.',
};

const RUN_FAILURE_MESSAGES: Record<string, string> = {
  accession_missing: 'La corrida no tiene un identificador UniProt válido.',
  active_run_slot: 'Ya existe una corrida activa para esta cuenta.',
  configuration_missing: 'La configuración científica de la corrida está incompleta.',
  cpu_budget_insufficient: 'Los recursos de CPU configurados no cubren esta etapa.',
  dependency_unavailable: 'Una etapa previa no produjo un resultado utilizable.',
  gpu_budget_insufficient: 'Los recursos de GPU configurados no cubren esta etapa.',
  hpc_authentication_failed: 'No fue posible autenticar la conexión con el clúster.',
  hpc_configuration_error: 'La conexión con el clúster no está configurada correctamente.',
  hpc_configuration_unavailable: 'La ejecución remota no está configurada.',
  hpc_host_key_rejected: 'No se pudo verificar la identidad del clúster remoto.',
  identity_mismatch: 'La identidad de la proteína no coincide con la configuración confirmada.',
  input_integrity_failed: 'Un archivo de entrada no superó la verificación de integridad.',
  input_unavailable: 'Uno de los archivos de entrada ya no está disponible.',
  lease_expired: 'La etapa perdió su reserva de ejecución y debe reintentarse.',
  no_selected_stages: 'La corrida no contiene etapas seleccionadas.',
  prefetch_adapter_unavailable: 'No está disponible el adaptador para preparar los datos externos.',
  prefetch_configuration_unavailable: 'La preparación de datos externos no está configurada.',
  prefetch_failed: 'No fue posible preparar los datos externos requeridos.',
  prefetch_incomplete: 'La preparación de datos externos quedó incompleta.',
  prefetch_profile_unavailable: 'La preparación requiere un perfil de ejecución remota.',
  prefetch_transport_unavailable: 'Se perdió la conexión mientras se preparaban los datos externos.',
  remote_job_failed: 'La ejecución remota finalizó con error.',
  sequence_identity_mismatch: 'La secuencia no coincide con la configuración confirmada.',
  stage_execution_unavailable: 'Esta etapa no tiene un ejecutor científico habilitado.',
  structure_input_missing: 'La entrada estructural está incompleta.',
  structure_mapping_missing: 'La estructura no tiene un mapeo canónico validado.',
  technical_prerequisite_missing: 'Falta un prerrequisito técnico para ejecutar esta etapa.',
  variants_missing: 'Esta etapa requiere al menos una variante confirmada.',
};

export function userErrorMessage(error: unknown, fallback = 'No se pudo completar la operación.'): string {
  if (!error || typeof error !== 'object' || !('status' in error)) return fallback;
  const status = typeof error.status === 'number' ? error.status : Number.NaN;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  if (code && RUN_FAILURE_MESSAGES[code]) return RUN_FAILURE_MESSAGES[code];
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  return fallback;
}

export function runFailureMessage(code?: string | null, _rawMessage?: string | null): string {
  if (code && RUN_FAILURE_MESSAGES[code]) return RUN_FAILURE_MESSAGES[code];
  if (code?.startsWith('hpc_')) return 'La comunicación con el clúster no se completó correctamente.';
  if (code?.startsWith('prefetch_')) return 'No fue posible preparar todos los datos externos requeridos.';
  return 'La ejecución no se completó. El equipo técnico puede consultar el diagnóstico interno.';
}
