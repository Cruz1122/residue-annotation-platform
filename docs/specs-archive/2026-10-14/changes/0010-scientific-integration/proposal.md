# 0010 — Migración e integración de los 18 stages

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Ciencia. **Dependencias:** `0007`, `0008`, `0009`.

## Why

Ejecutar científicamente el pipeline real preservando contratos y sin acoplar ciencia a FastAPI.

## Alcance propuesto

Paquetes stages/<stage_id>, StageResult, core/io/contract; migración por lotes y gates de equivalencia con fixtures reales.

## Fuera de alcance

Sin nueva predicción clínica ni refactor simultáneo de algoritmos y arquitectura.

## Riesgos y alternativas

Deprecación inadvertida de stage, datos NA falsos, diferencias de herramientas.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
