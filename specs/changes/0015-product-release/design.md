# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Contexto y dirección técnica (HOW)

Golden P01130 autorizado + otros fixtures, E2E Astro→FastAPI→worker→Slurm/GPFS→annotations→3D; performance, seguridad, continuidad y sign-off.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Despliegue verde con ciencia distinta, autorización incompleta o GPU sin presupuesto.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.

## Inspección del directorio remoto (sin writes)

Durante esta fase, la lectura opcional de evidencia BSC usa [`../../contracts/mn5-readonly-inspection.md`](../../contracts/mn5-readonly-inspection.md) y [`../../tests/mn5-readonly-inspection-matrix.md`](../../tests/mn5-readonly-inspection-matrix.md). `ReadOnlyMN5Inspector` **no** expone shell, escrituras ni Slurm. La cuenta SSH password-only y la VPN se gestionan fuera de frontend/CI; no conectar sin autorización y no usar datos inventados ante fallos de red. El uso de `HPCClient` para jobs es otro contrato.
