# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Why

Coordinar trabajo desde segundo entrypoint del mismo backend, no otro microservicio.

## Alcance propuesto

app.worker usa el mismo paquete/DB que app.main; pipeline, claim/leases y simulador determinista para tests; no HTTP interno.

## Fuera de alcance

No usar Slurm real ni lanzar AlphaFold en este cambio.

## Riesgos y alternativas

Double-submit y estados zombies cuando cae worker.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
