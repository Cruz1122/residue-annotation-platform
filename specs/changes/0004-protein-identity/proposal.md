# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Why

Registrar secuencias FASTA y aliases de manera idempotente.

## Alcance propuesto

Feature proteins con PostgreSQL, Alembic y service de normalización/hashing SHA-256; aliases separados.

## Fuera de alcance

Sin jobs HPC, stages científicos ni un uploader masivo.

## Riesgos y alternativas

Normalizaciones biológicamente incorrectas y duplicados al registrar secuencias equivalentes.

Alternativa descartada: implementar varias fases juntas sin criterios auditables.

## Bloqueos previos

Resolver decisiones pertinentes en `specs/DECISIONS.md`, confirmar responsables/recursos y aprobar explícitamente este change.
