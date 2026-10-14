# 0014 — Operaciones, recovery y despliegue

**Estado:** PARTIAL local — aceptación de staging/producción pendiente. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `OPS-001` | Chaos test. Given worker cae, when restart, then reconcilia job_id. | **PARTIAL local** | `test_worker_entrypoint_restart_reconciles_abandoned_stage` mata un worker real después del claim y un segundo `python -m app.worker` recupera el lease, reintenta una vez y libera el slot; la frontera SSH/native persiste un receipt `.submitted` junto al job directory y recupera el mismo `job_id` tras perder la respuesta de `sbatch`, cubierto por tests de ambos clientes; la reconciliación de un `job_id` Slurm real sigue pendiente. |
| `OPS-002` | Restore drill. Given snapshot, when restore aislado, then runs legibles. | **PASS local aislado** | El bundle PostgreSQL/artifacts se verificó y se restauró en un destino PostgreSQL 16 aislado; no es un sign-off de producción. |
| `OPS-003` | Incident drill. Given stage falla, when consulta por run_id, then causa localizable. | **PARTIAL local** | Eventos correlacionados y `error_code`/`error_message` sanitizados están implementados y probados; `/api/v1/metrics` combina contadores del proceso con gauges agregados desde PostgreSQL (`run status`, `stage/status`, slots y disponibilidad de DB), sin exponer `run_id`/`job_id`; `backend/tests/test_health.py::test_metrics_endpoint_reports_durable_run_and_stage_state` lo verifica. Tras reconstruir el backend del checkout en `919f39d`, el Compose activo devolvió `rap_metrics_database_available 1`, estados agregados de runs/stages y slots activos. `infra/monitoring/prometheus-rules.yml` define tres reglas portables y `yq` valida su estructura; el commit `760956e` unifica la propagación de configuración operativa desde `.env` a los workers. `1f1a63c` añade healthcheck HTTP del backend y hace que el frontend espere `service_healthy`; esto cubre la dependencia de disponibilidad de arranque, pero no reemplaza un receptor de alertas. No se desplegó Prometheus/Alertmanager ni se ejecutó el drill operativo con un incidente real. |
| `OPS-004` | Staging drill. Given release candidate, when rollout, then smoke y rollback verificados. | **PARTIAL local** | El stack local real con perfil `vpn` quedó arriba: `vpn=healthy`, `worker-vpn=running`, backend health y DB readiness devolvieron `{"status":"ok"}` y frontend HTTP 200; el log VPN llegó a `Tunnel is up and running`. Compose/migraciones tienen smoke local, pero no se ejecutó staging ni rollback real y no se creó ninguna run durante esta verificación. |

| `OPS-005` | Linux/Windows connectivity drills y revisión de hosting BSC.; Given caída VPN durante job activo, when falla inspección, then job no pasa a failed por desconexión. Given Windows con VPN sin ruta desde contenedor, then preflight reporta bloqueo. | **PARTIAL Linux / Windows NOT RUN** | VPN/SFTP Linux y la política de desconexión del executor están revisadas; `HPCTransportError` conserva stages aceptados como retryable durante polling/ingesta, `HPCConfigurationError` evita reintentos infinitos por binarios Slurm ausentes y los tests cubren ambas rutas; Windows/WSL2, hosting BSC persistente y caída VPN durante job activo no se ejecutaron. |

## Registro de ejecución obligatorio

- Fecha UTC: 2026-10-14
- Commit/release: `e65b705` (verificación local; no es sign-off de staging/producción)
- Comando/entorno/exit code: suite local (`209 passed, 11 skipped`), PostgreSQL 16 aislado (`220 passed`), Ruff, `docker compose build vpn`, los tres perfiles Compose config, secret scan y smoke SFTP read-only terminaron con código 0
- Logs/artefactos/capturas: no se incluyeron secretos ni resultados científicos masivos
- Evaluación científica/operacional: operaciones locales verificadas; staging, rollback, Windows y Slurm NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
