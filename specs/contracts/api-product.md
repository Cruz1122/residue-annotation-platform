# Contrato REST/SSE objetivo — DRAFT

Basado en la arquitectura objetivo p. 6. Prefijo de API propuesto `/api/v1`, no esquema OpenAPI definitivo.

| Método | Ruta | Comportamiento | Error obligatorio |
| --- | --- | --- | --- |
| GET | `/health` | liveness del proceso FastAPI | 5xx si proceso indisponible |
| GET | `/health/db` | readiness de PostgreSQL cuando exista | 503 DB caída |
| POST | `/proteins` | resolver/registrar secuencia y aliases; retorno tipado | 422 input inválido, 413 tamaño excesivo |
| GET | `/proteins/{id}` | metadata estable autorizada | 403/404 |
| POST | `/runs` | crear run asíncrona, activar flujo del worker | 403/422/409 o cuota excedida |
| GET | `/runs/{id}` | estado global/timestamps/resumen de stages | 403/404 |
| GET | `/runs/{id}/stages` | estados detallados pending/ready/queued/running/reused/success/failed/skipped y cancelación | 403/404 |
| GET | `/runs/{id}/annotations` | vista per-residue de resultados ya verificados, incluso parciales | 403/404 |
| GET | `/runs/{id}/events` | SSE de progreso con heartbeat y recuperación por snapshot/replay | 401/403/404 |
| GET | `/artifacts/{id}` | metadata y streaming/descarga autorizada | 403/404, sin path traversal |
| POST | `/runs/{id}/cancel` | solicitar cancelación de stages activos | 403/404/409 |

Requisitos globales: OpenAPI generada, errores tipados sin stack traces, versionado, validación de inputs, paginación para listas, headers/cache adecuados y estados HTTP consistentes. La política de idempotencia de POST /runs, selección de formato para annotations, Last-Event-ID/replay SSE, errores y límite de payload requieren diseño final y pruebas.

**SSE no es almacenamiento de eventos por sí mismo:** al reconectar se reconsulta estado persistido. POST no espera etapas científicas largas. La UI no consume Slurm ni GPFS.

## Aclaración sobre archivos GPFS remotos

Este contrato de producto **no** incluye un navegador general del filesystem BSC. La inspección remota documentada en [`mn5-readonly-inspection.md`](mn5-readonly-inspection.md) es una capacidad **operativa de agentes/desarrolladores** bajo VPN+SSH/SFTP read-only. No se debe exponer automáticamente mediante endpoints nuevos. El endpoint `/artifacts/{id}` existente sigue vinculado a artefactos registrados, autorización de dominio y storage keys relativas; no acepta paths GPFS elegidos libremente por un usuario.
