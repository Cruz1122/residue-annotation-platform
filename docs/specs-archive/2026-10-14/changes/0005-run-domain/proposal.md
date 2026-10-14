# 0005 — Runs, stages, resultados y artefactos

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F2 Dominio. **Dependencias:** `0004`.

## Why

Representar solicitudes de ejecución separadas de resultados científicos compartidos.

## Alcance propuesto

Modelos run, run_stage, stage_result, artifact, futuros annotation_<stage> tipados; endpoints CRUD mínimo y máquina de estados.

## Fuera de alcance

No enviar Slurm ni ejecutar un stage científico dentro de FastAPI.

## Riesgos y alternativas

Duplicación de resultados o transiciones inválidas.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
