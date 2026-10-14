# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Why

Demostrar el producto final completo con datos científicos y HPC reales.

## Alcance propuesto

Golden P01130 autorizado + otros fixtures, E2E Astro→FastAPI→worker→Slurm/GPFS→annotations→3D; performance, seguridad, continuidad y sign-off.

## Fuera de alcance

No aprobar release con resultados simulados ni tests unitarios como sustituto HPC.

## Riesgos y alternativas

Despliegue verde con ciencia distinta, autorización incompleta o GPU sin presupuesto.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.

## Restricción transversal añadida

Cualquier necesidad de inspeccionar los outputs reales ya existentes en MN5 se resuelve mediante **solo lectura** en la ruta GPFS definida en el contrato de inspección. No es un requisito para crear un nuevo explorador web ni concede autorización para modificar/borrar/publicar archivos remotos.
