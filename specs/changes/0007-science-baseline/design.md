# 0007 — Baseline y reconciliación científica

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ciencia. **Dependencias:** `0002`.

## Contexto y dirección técnica (HOW)

Snapshot código/recursos, golden outputs P01130 y contratos por stage; resolver divergencias de nombres del PDF y pipeline documentado.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Refactor que altera ciencia o presenta equivalencia sin comparar artefactos reales.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.

## Inspección del directorio remoto (sin writes)

Durante esta fase, la lectura opcional de evidencia BSC usa [`../../contracts/mn5-readonly-inspection.md`](../../contracts/mn5-readonly-inspection.md) y [`../../tests/mn5-readonly-inspection-matrix.md`](../../tests/mn5-readonly-inspection-matrix.md). `ReadOnlyMN5Inspector` **no** expone shell, escrituras ni Slurm. La cuenta SSH password-only y la VPN se gestionan fuera de frontend/CI; no conectar sin autorización y no usar datos inventados ante fallos de red. El uso de `HPCClient` para jobs es otro contrato.
