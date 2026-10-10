# 0011 — REST/SSE y anotaciones parciales

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F5 Producto. **Dependencias:** `0005`, `0006`, `0008`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Exponer estados y annotations en progreso sin bloquear requests ni filtrar artefactos.

**No objetivos:** No exigir finalización total, no streaming directo de storage_key GPFS.

### REQ-API-001 — Resultados parciales

MUST: annotations integra sólo etapas success/reused y distingue pending/failed/NA.

- **Escenario verificable:** Given run parcialmente completada, when GET annotations, then muestra sólo evidencia disponible.
- **Prueba prevista:** Integration API.

### REQ-API-002 — SSE resiliente

MUST: cliente recupera estado actual después de corte de conexión por snapshot o replay.

- **Escenario verificable:** Given caída SSE, when reconecta, then converge con DB.
- **Prueba prevista:** E2E reconnect.

### REQ-API-003 — Artefactos autorizados

MUST: por artifact_id y controles backend; sin path traversal o GPFS absoluto.

- **Escenario verificable:** Given path inseguro, when request, then 403/404 sin filtrar ruta.
- **Prueba prevista:** Security negative.

### REQ-API-004 — API rápida sin ciencia

MUST: endpoints de estado no esperan AF3/BioEmu.

- **Escenario verificable:** Given AF3 running, when GET run, then responde estado persistente.
- **Prueba prevista:** Latency integration test.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0005`, `0006`, `0008`.
- Resolver ADR relevante antes de decisiones irreversibles.
