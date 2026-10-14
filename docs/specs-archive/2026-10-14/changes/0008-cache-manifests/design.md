# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Contexto y dirección técnica (HOW)

stage_result cache_key versionada (stage, código, upstream, parámetros, recursos, tool_versions); staging→manifest final→validación→registro transaccional.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Success parcial, corrupción de artifact o invalidación incompleta.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.
