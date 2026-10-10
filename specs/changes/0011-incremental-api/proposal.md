# 0011 — REST/SSE y anotaciones parciales

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F5 Producto. **Dependencias:** `0005`, `0006`, `0008`.

## Why

Exponer estados y annotations en progreso sin bloquear requests ni filtrar artefactos.

## Alcance propuesto

Endpoints /runs/{id}/annotations, /events y /artifacts/{id}; SSE con resync GET; composición de stage_result completados; errores tipados.

## Fuera de alcance

No exigir finalización total, no streaming directo de storage_key GPFS.

## Riesgos y alternativas

Reconexión SSE incompleta, fugas de artifact y falsos valores para stages pendientes.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
