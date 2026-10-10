# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Contexto y dirección técnica (HOW)

Feature proteins con PostgreSQL, Alembic y service de normalización/hashing SHA-256; aliases separados.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Normalizaciones biológicamente incorrectas y duplicados al registrar secuencias equivalentes.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.
