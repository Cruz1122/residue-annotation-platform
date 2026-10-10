# 0010 — Migración e integración de los 18 stages

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Ciencia. **Dependencias:** `0007`, `0008`, `0009`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Ejecutar científicamente el pipeline real preservando contratos y sin acoplar ciencia a FastAPI.

**No objetivos:** Sin nueva predicción clínica ni refactor simultáneo de algoritmos y arquitectura.

### REQ-STAGE-001 — Contrato uniforme

MUST: cada stage declara deps, inputs/outputs, versiones, cache factors, recursos y NA.

- **Escenario verificable:** Given registry, when audit, then 18 contratos verificables.
- **Prueba prevista:** Registry validation.

### REQ-STAGE-002 — Integridad per-residue

MUST: comprobar cobertura 1..L y aa_ref, conservando unidades específicas.

- **Escenario verificable:** Given salida desalineada, when ingesta, then rechazo controlado.
- **Prueba prevista:** Scientific smoke.

### REQ-STAGE-003 — Rollout por lote

MUST: activar stage sólo después de sintaxis, tests, smoke real y comparación.

- **Escenario verificable:** Given smoke pendiente, when review, then stage no se declara verified.
- **Prueba prevista:** Matriz PASS/NOT RUN.

### REQ-STAGE-004 — Sin inventar ciencia

MUST: fallo de dependencia produce failed/NA según contrato, nunca success artificial.

- **Escenario verificable:** Given herramienta ausente, when stage ejecuta, then failure auditado.
- **Prueba prevista:** Preflight negativo.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0007`, `0008`, `0009`.
- Resolver ADR relevante antes de decisiones irreversibles.
