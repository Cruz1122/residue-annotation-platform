# 0013 — Identidad, autorización y cuotas HPC

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL; aprobación externa y threat model independiente pendientes. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Why

Controlar quién accede a proteínas, runs, artefactos y cómputo costoso.

## Alcance propuesto

Autenticación institucional por ADR, scopes/proyectos, authorizer backend, límites de inputs, rate/quotas y auditoría.

## Fuera de alcance

No elegir proveedor SSO sin política BSC ni asumir datos públicos por default.

## Riesgos y alternativas

IDOR, secretos en logs, compartición incorrecta de stage_result y abuso GPU.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.

## Restricción transversal añadida

Cualquier necesidad de inspeccionar los outputs reales ya existentes en MN5 se resuelve mediante **solo lectura** en la ruta GPFS definida en el contrato de inspección. No es un requisito para crear un nuevo explorador web ni concede autorización para modificar/borrar/publicar archivos remotos.
