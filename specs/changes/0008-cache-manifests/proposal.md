# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Why

Publicar results íntegros y reutilizar stage_result sólo cuando es científicamente compatible.

## Alcance propuesto

stage_result cache_key versionada (stage, código, upstream, parámetros, recursos, tool_versions); staging→manifest final→validación→registro transaccional.

## Fuera de alcance

No aceptar DONE o solo SHA de secuencia como señal suficiente de cache hit.

## Riesgos y alternativas

Success parcial, corrupción de artifact o invalidación incompleta.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
