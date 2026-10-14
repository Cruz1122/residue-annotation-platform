# 0016 — Autenticación, sesiones y límite de ejecución por usuario

**Estado:** DRAFT — PENDING ACCEPTANCE — NO APROBADO.

## Diseño

- `users` guarda email normalizado, scrypt hash, proyecto por defecto, estado de verificación y `token_version`.
- Access tokens JWT HS256 de vida corta sólo contienen identificadores, tipo, versión, `jti`, `iat` y `exp`; el secreto se configura fuera del repositorio en entornos compartidos.
- Refresh tokens y tokens de email/reset se generan con CSPRNG, se persisten sólo como SHA-256 y se invalidan por rotación, consumo, expiración o cambio de password.
- Resend entrega los enlaces de verificación y recuperación en HTML/text desde una URL frontend configurada; la API key sólo vive en el entorno y producción exige un dominio remitente verificado.
- `get_principal` acepta Bearer validado; el fallback `dev_user/dev_project` sólo aplica en development/test. Los endpoints de cuenta siempre requieren Bearer cuando representan una sesión.
- `rate_limit_buckets` usa ventana persistida y locks de fila; las rutas de auth devuelven `429` con `Retry-After` sin revelar secretos.
- `audit_events` registra metadatos mínimos; no se guardan password, raw token ni contenido de uploads.
- `active_run_slots.owner_id` es la reserva única transaccional para la regla de una run activa por usuario.
- `uploads` usa claves UUID bajo `ARTIFACT_ROOT/uploads/`; para el pipeline remoto el worker deriva `/configured-root/uploads/<scientific_accession>/.platform_runs/<run_id>/{fasta,pdb}/<upload_id>.<suffix>`, valida que la transferencia corresponda al path esperado y exporta `PIPELINE_SELECTED_FASTA/PDB`. El cliente SCP sólo opera con host key/password file protegidos. La API acepta mmCIF, pero el CLI MN5 inspeccionado sólo acepta PDB para estructuras; el worker rechaza esa combinación de forma explícita hasta que exista un conversor científico aprobado.

## Compatibilidad

Los endpoints existentes continúan funcionando en development/test con el principal local para no romper el scaffold. La ruta de producción es Bearer y el fallback de headers queda deshabilitado por defecto.

## Riesgos y pendientes

Resend ya está seleccionado e integrado, pero la entrega real con dominio verificado sigue sin evidencia. También quedan pendientes SSO institucional, rotación de secreto JWT y almacenamiento distribuido de rate limits. La aceptación debe incluir tests IDOR HTTP/Bearer independientes con dos principals PostgreSQL, secret scan, fault injection, email delivery y SCP autorizado. Los tests de concurrencia PostgreSQL de sesiones, slots, claims y ownership service-level pasan en una base aislada; la corrida HTTP/Bearer independiente sigue pendiente.

## Rollback

La migración `0002_auth_uploads` se puede revertir antes de crear cuentas reales. Para un entorno con usuarios, el rollback requiere backup y decisión explícita; no se deben borrar cuentas, tokens o uploads sin procedimiento aprobado.
