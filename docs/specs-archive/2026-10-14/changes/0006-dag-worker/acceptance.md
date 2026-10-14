# 0006 — Worker y pipeline persistente

**Estado:** PARTIAL local; entrypoint y lógica de estados están implementados. El restart del entrypoint real local y la suite PostgreSQL aislada ya ejecutaron los escenarios de recuperación/claims/cancelación; la ejecución Slurm sigue pendiente.

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| EXEC-001 | Reinicio web no elimina el estado del worker | PARTIAL | Runtime Compose con PostgreSQL/Alembic/worker arrancó y conservó estado; `test_worker_entrypoint_restart_reconciles_abandoned_stage` ejecutó un proceso `worker.run_forever()` que murió tras reclamar y un segundo `python -m app.worker` que recuperó el lease, reintentó una vez y liberó el slot. La submission remota usa un recibo `.submitted` determinista para recuperar el mismo `job_id` si se pierde la respuesta de `sbatch`, evitando doble submit; `test_native_slurm_submission_receipt_recovers_without_resubmit` y la frontera SSH equivalente lo verifican localmente. La prueba `test_remote_configuration_outage_keeps_stage_durable_and_retries` confirma que una configuración SSH ausente no tumba el ciclo ni crea un fallo científico: la etapa queda durable y reintentable; falta repetir el escenario con un job Slurm real |
| EXEC-002 | Ready sólo después de dependencias y descendientes afectados | PASS local | `test_ready_states_require_all_dependencies` recorre las 18 definiciones del registry y verifica que sólo las etapas con todas sus dependencias `success/reused` pasan a `ready`; `test_dependency_failure_propagates_skipped_descendants` repite los ticks de refresh y confirma que un fallo de `protein_identity` deja todos sus descendientes `skipped`, sin habilitar una rama incompleta. Slurm real sigue pendiente sólo para EXEC-001/003/004. |
| EXEC-003 | Claim transaccional exclusivo | PASS local PostgreSQL; ejecución remota pendiente | claim usa `FOR UPDATE SKIP LOCKED` con `LIMIT 1`, attempt_count, lease y claim de polling identificable; los tests concurrentes pasan en PostgreSQL 16; el hilo de heartbeat durante una ejecución larga real no es verificable con el executor placeholder actual |
| EXEC-004 | Cancelación durable no agenda nuevos stages | PASS local PostgreSQL; Slurm pendiente | cancel endpoint lockea stages+run, claim excluye cancelados, `transition_stage` relee el estado persistido y `finalize_run` no sobrescribe runs terminales; falta prueba con job Slurm real |

## Registro de ejecución

Fecha UTC: 2026-10-14
Comando: uv run pytest -q
Resultado actual: 209 tests PASS localmente y los 11 escenarios concurrentes pasan en la ejecución completa de 220 tests contra PostgreSQL 16 aislado; incluye modelo, transiciones, annotations, auth, uploads, recuperación de leases, claims, cancelación/finalización, restart del entrypoint real, recuperación de submission receipts, integridad de inputs, recuperación de temporales de transferencia nativa, reintento ante configuración HPC no disponible y fronteras read-only. Slurm real: NOT RUN.
