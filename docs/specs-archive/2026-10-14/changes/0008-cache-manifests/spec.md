# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Publicar results íntegros y reutilizar stage_result sólo cuando es científicamente compatible.

**No objetivos:** No aceptar DONE o solo SHA de secuencia como señal suficiente de cache hit.

### REQ-CACHE-001 — Key completa

MUST: cambios de parámetros científicos y recursos alteran cache_key; log level no.

- **Escenario verificable:** Given resource hash distinto, when recalc cache_key, then cambia.
- **Prueba prevista:** Property key tests.

### REQ-CACHE-002 — Hits validables

MUST: reusable sólo success con manifest y artefactos obligatorios verificables.

- **Escenario verificable:** Given artifact perdido, when lookup, then cache miss.
- **Prueba prevista:** Fault injection.

### REQ-CACHE-003 — Publicación atómica

MUST: no registrar success si manifest final no se ha escrito y validado.

- **Escenario verificable:** Given crash previo a manifest, when recovery, then no hay success parcial.
- **Prueba prevista:** Crash test.

### REQ-CACHE-004 — Provenance auditable

MUST: outputs registran inputs, versiones, hashes, herramienta y unidades sin rutas públicas GPFS.

- **Escenario verificable:** Given stage success, when auditor revisa metadata, then reproduce origen.
- **Prueba prevista:** Audit review.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0005`, `0006`, `0007`.
- Resolver ADR relevante antes de decisiones irreversibles.
