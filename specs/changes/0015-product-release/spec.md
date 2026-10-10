# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Demostrar el producto final completo con datos científicos y HPC reales.

**No objetivos:** No aprobar release con resultados simulados ni tests unitarios como sustituto HPC.

### REQ-REL-001 — Flujo E2E real

MUST: registro→run→reuso/ejecución→annotations→visualización→artefactos opera en MN5.

- **Escenario verificable:** Given proteína real autorizada, when recorrido, then datos no inventados.
- **Prueba prevista:** E2E real.

### REQ-REL-002 — Reuso selectivo

MUST: segunda run idéntica no recalcula stages válidos; cambio relevante invalida afectados.

- **Escenario verificable:** Given cache válido, when run repetida, then reuse; dado cambio de parámetro, then miss selectivo.
- **Prueba prevista:** Cache E2E.

### REQ-REL-003 — Regresión científica

MUST: 18 stages cumplen baseline de unidades, aa_position, aa_ref, NA y provenance.

- **Escenario verificable:** Given outputs reales, when diff con baseline, then desvíos justificados.
- **Prueba prevista:** Regresión científica completa.

### REQ-REL-004 — Release auditado

MUST: requisitos obligatorios tienen evidencia PASS o waiver aprobado, restore y security gate.

- **Escenario verificable:** Given release candidate, when sign-off, then matriz sin MUST huérfanos.
- **Prueba prevista:** Release checklist.

### REQ-REL-005 — Aceptación de permisos remotos y ausencia de escrituras

MUST: La entrega final MUST demostrar que cualquier inspección remota de desarrollo usa exclusivamente operaciones de lectura dentro del perímetro aprobado y que accesos externos/dotfiles/secretos y mutaciones son rechazados por diseño, con autorización BSC confirmada o limitación explícita.

- **Escenario verificable:** Given inspección MN5 aprobada, when se consultan archivos existentes, then no hay alteración atribuible. Given no autorización, then integración se marca BLOCKED/NOT RUN, no PASS ficticio.
- **Prueba prevista:** INS-01..INS-18, revisión independiente de permisos y evidencia del smoke read-only.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0012`, `0013`, `0014`.
- Resolver ADR relevante antes de decisiones irreversibles.
