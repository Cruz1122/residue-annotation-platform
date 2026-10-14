# Proposal 0001 — Scaffold Astro + FastAPI

**Status:** proposed — pendiente de aprobación.  
**Depends on:** ninguna.  
**Milestone:** M0.  
**Tipo:** infraestructura mínima para comenzar a desarrollar.

## Why

Hace falta una base común para desarrollar una UI científica y su backend sin decidir todavía cómo persistir runs o lanzar el pipeline. Hoy lo que necesitamos verificar es que la estructura acordada existe y que el browser puede comunicarse con FastAPI de forma real.

## What changes

Se crea un monorepo con `frontend/`, `backend/`, Dockerfiles, `compose.yml`, `README.md` y configuración local mínima. La única capacidad de backend es `GET /api/v1/health`. La única interacción frontend obligatoria es mostrar el estado real de ese backend. Se reservan directorios de features sin implementar dominio.

## Out of scope

PostgreSQL, Alembic, `worker`, SSE, autenticación, upload FASTA/PDB, render molecular, manejo de proteínas y runs, anotaciones, artifacts, cache, HPC, Slurm, GPFS, CI avanzada o etapas científicas.

## Impacto y riesgos

- **Configuración del navegador:** dentro de Docker, `localhost:8742` no tiene el mismo sentido que dentro del contenedor. La llamada de la UI es browser-side y requiere URL accesible desde el navegador.
- **CORS:** origen local exacto y explícito; no abrir globalmente en preparación de producción.
- **Tecnología:** Astro + TypeScript y FastAPI/Python 3.12. No introducir un framework UI adicional de forma implícita.
- **Alcance:** el error más probable es generar una plataforma falsa con servicios y modelos vacíos en vez del scaffold mínimo.

## Alternatives considered

- **Todo el backend en un solo `main.py`:** cómodo ahora, pero dispersa la evolución. Se prefiere un composition root pequeño y un router de health por feature.
- **Construir PostgreSQL y worker inmediatamente:** descartado porque no existe en este cambio un escenario de negocio que lo exija.
- **Estructura por capas globales:** descartado en favor de agrupación por features.

## Open questions

Ninguna que bloquee el scaffold. La elección de gestor de dependencias se hará en diseño según herramientas disponibles, sin introducir un segundo framework.

## Approval

- [ ] Objetivo y exclusiones aceptados
- [ ] Diseño revisado
- [ ] Se autoriza implementar **solo** `0001`

**Decision / date:** pendiente.
