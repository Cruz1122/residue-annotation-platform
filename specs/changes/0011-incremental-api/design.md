# 0011 — REST/SSE y anotaciones parciales

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F5 Producto. **Dependencias:** `0005`, `0006`, `0008`.

## Contexto y dirección técnica (HOW)

Endpoints /runs/{id}/annotations, /events y /artifacts/{id}; SSE con resync GET; composición de stage_result completados; errores tipados.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Reconexión SSE incompleta, fugas de artifact y falsos valores para stages pendientes.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.

## Límite de la inspección técnica

La inspección opcional de carpetas MN5 en las specs de desarrollo **no exige una UI de exploración de GPFS**, endpoints GET arbitrarios ni acceso SSH del navegador. La visualización molecular del producto consume artefactos autorizados por su ID o fixtures aprobados. El acceso técnico de agentes por VPN+SSH+SFTP solo lectura se rige por `specs/contracts/mn5-readonly-inspection.md`.
