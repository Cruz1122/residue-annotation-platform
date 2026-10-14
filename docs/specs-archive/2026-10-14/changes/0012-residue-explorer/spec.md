# 0012 — Explorer 3D + secuencia + anotaciones

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F5 Experiencia. **Dependencias:** `0003`, `0010`, `0011`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Ofrecer el flujo proteína→run→estructura real→residuo→métricas y evidencia.

**No objetivos:** Sin conclusiones clínicas ni asumir número PDB = aa_position.

### REQ-UX-001 — Flujo usuario

MUST: una run permite abrir modelo real y consultar anotaciones de residuo seleccionado.

- **Escenario verificable:** Given run validada, when click en 3D, then panel muestra posición y aa_ref correctos.
- **Prueba prevista:** E2E con fixture real.

### REQ-UX-002 — Selección sincronizada

MUST: clic de 3D, secuencia, tracks y tabla identifica la misma entidad mapeada.

- **Escenario verificable:** Given residuo con mapping, when selección en tabla, then 3D destaca el mismo.
- **Prueba prevista:** E2E bidireccional.

### REQ-UX-003 — Estados científicos claros

MUST: diferenciar NA, cero, pending, failed, not applicable y unidades.

- **Escenario verificable:** Given evidencia ausente, when selecciono residuo, then UI NO muestra 0.
- **Prueba prevista:** UI/QC tests.

### REQ-UX-004 — Accesibilidad y benchmark

MUST: selección por teclado y rendimiento medido con estructuras reales y hardware descrito.

- **Escenario verificable:** Given teclado, when elegir residuo, then se muestra texto/selección sincronizada.
- **Prueba prevista:** A11Y + benchmark.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0003`, `0010`, `0011`.
- Resolver ADR relevante antes de decisiones irreversibles.
