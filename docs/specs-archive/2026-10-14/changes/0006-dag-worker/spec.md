# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Coordinar trabajo desde segundo entrypoint del mismo backend, no otro microservicio.

**No objetivos:** No usar Slurm real ni lanzar AlphaFold en este cambio.

### REQ-EXEC-001 — Separación operativa

MUST: reiniciar web no interrumpe el seguimiento del worker.

- **Escenario verificable:** Given worker activo y web reiniciado, when consulta, then estado preservado.
- **Prueba prevista:** Integration restart.

### REQ-EXEC-002 — Dependencias del pipeline

MUST: stage ready solo después de deps científicas; ready no implica recursos asignados.

- **Escenario verificable:** Given rama fallida y hermana independiente, when avanza, then sólo descendientes afectados se bloquean.
- **Prueba prevista:** Prueba unitaria del pipeline.

### REQ-EXEC-003 — Claim transaccional

MUST: dos workers no reclamaran el mismo run_stage activo simultáneamente.

- **Escenario verificable:** Given workers concurrentes, when claim, then uno solo adquiere lease.
- **Prueba prevista:** Test Postgres concurrente.

### REQ-EXEC-004 — Cancelación durable

MUST: cancelar run evita nuevas submits y preserva historia terminal.

- **Escenario verificable:** Given cancel solicitado, when worker lee, then no agenda nuevos stages.
- **Prueba prevista:** Test cancelación.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0005`.
- Resolver ADR relevante antes de decisiones irreversibles.
