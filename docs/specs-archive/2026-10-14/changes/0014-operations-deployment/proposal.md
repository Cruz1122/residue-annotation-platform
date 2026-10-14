# 0014 — Operaciones, recovery y despliegue

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL; staging/producción y aprobación operativa pendientes. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Why

Operar en entorno autorizado con recuperación de jobs, backups y observabilidad.

## Alcance propuesto

Runbooks dev/staging/prod, métricas por run/stage, reconciliación SLURM, backups/restore, migrations, rollback y despliegue aprobado.

## Fuera de alcance

Sin afirmar que Compose sea stack de producción HPC.

## Riesgos y alternativas

Worker muerto, orfandad de jobs, migración de DB irreversible y falta de trazabilidad.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.

## Restricción transversal añadida

Cualquier necesidad de inspeccionar los outputs reales ya existentes en MN5 se resuelve mediante **solo lectura** en la ruta GPFS definida en el contrato de inspección. No es un requisito para crear un nuevo explorador web ni concede autorización para modificar/borrar/publicar archivos remotos.
