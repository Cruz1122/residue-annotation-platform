# 0005 — Runs, stages, resultados y artefactos

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0004`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Representar solicitudes de ejecución separadas de resultados científicos compartidos.

**No objetivos:** No enviar Slurm ni ejecutar un stage científico dentro de FastAPI.

### REQ-RUN-001 — Creación no bloqueante

MUST: POST /runs crea run durable y retorna 201 sin esperar ciencia.

- **Escenario verificable:** Given protein válida, when POST run, then queda pending en DB y devuelve ID.
- **Prueba prevista:** Contrato API + test DB.

### REQ-RUN-002 — Ownership correcto

MUST: StageResult es independiente de Run; RunStage y Artifact referencian StageResult de forma íntegra.

- **Escenario verificable:** Given dos runs reutilizando cálculo, when se consulta, then comparten stage_result sin copia de artefactos.
- **Prueba prevista:** Test FK/reuse.

### REQ-RUN-003 — Estados válidos

MUST: transiciones invalidas de estado se rechazan con error auditable.

- **Escenario verificable:** Given stage success, when se intenta pasar a running sin retry, then rechaza.
- **Prueba prevista:** State machine tests.

### REQ-RUN-004 — Lectura verificable

MUST: GET run y stages reportan estado DB, con 404 para IDs inexistentes.

- **Escenario verificable:** Given run inexistente, when GET, then 404 sin inventar progreso.
- **Prueba prevista:** API negativos.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0004`.
- Resolver ADR relevante antes de decisiones irreversibles.
