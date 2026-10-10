# 0009 — Integración MareNostrum 5 / Slurm / GPFS

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 HPC. **Dependencias:** `0006`, `0008`.

## Why

Conectar jobs científicos al worker usando adaptadores internos y seguridad de recursos BSC.

## Alcance propuesto

HPCClient submit/status/cancel/read_manifest/open_artifact; storage GPFS relativo; worker científico sin credenciales DB; transporte acordado por ADR.

## Fuera de alcance

No ejecutar AF3 ni BioEmu como smoke inicial; no prometer Docker Compose dentro de nodos de cómputo.

## Riesgos y alternativas

Mala asignación de recursos, pérdida de salloc, secrets expuestos o transporte no permitido.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.

## Restricción transversal añadida

Cualquier necesidad de inspeccionar los outputs reales ya existentes en MN5 se resuelve mediante **solo lectura** en la ruta GPFS definida en el contrato de inspección. No es un requisito para crear un nuevo explorador web ni concede autorización para modificar/borrar/publicar archivos remotos.
