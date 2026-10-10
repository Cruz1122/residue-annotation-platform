# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Contexto y dirección técnica (HOW)

app.worker usa el mismo paquete/DB que app.main; pipeline, claim/leases y simulador determinista para tests; no HTTP interno.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Double-submit y estados zombies cuando cae worker.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.
