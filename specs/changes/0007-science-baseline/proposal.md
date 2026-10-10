# 0007 — Baseline y reconciliación científica

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ciencia. **Dependencias:** `0002`.

## Why

Congelar evidencia científica existente antes de cualquier refactor de los 18 stages.

## Alcance propuesto

Snapshot código/recursos, golden outputs P01130 y contratos por stage; resolver divergencias de nombres del PDF y pipeline documentado.

## Fuera de alcance

No cambiar algoritmos, thresholds, unidades ni requerir corrida completa al crear la spec.

## Riesgos y alternativas

Refactor que altera ciencia o presenta equivalencia sin comparar artefactos reales.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.

## Restricción transversal añadida

Cualquier necesidad de inspeccionar los outputs reales ya existentes en MN5 se resuelve mediante **solo lectura** en la ruta GPFS definida en el contrato de inspección. No es un requisito para crear un nuevo explorador web ni concede autorización para modificar/borrar/publicar archivos remotos.
