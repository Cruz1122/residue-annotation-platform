# 0010 — Migración e integración de los 18 stages

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Ciencia. **Dependencias:** `0007`, `0008`, `0009`.

## Contexto y dirección técnica (HOW)

Paquetes stages/<stage_id>, StageResult, core/io/contract; migración por lotes y gates de equivalencia con fixtures reales.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Deprecación inadvertida de stage, datos NA falsos, diferencias de herramientas.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.
