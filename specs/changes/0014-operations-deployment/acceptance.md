# 0014 — Operaciones, recovery y despliegue

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `OPS-001` | Chaos test. Given worker cae, when restart, then reconcilia job_id. | **NOT RUN** | PENDIENTE |
| `OPS-002` | Restore drill. Given snapshot, when restore aislado, then runs legibles. | **NOT RUN** | PENDIENTE |
| `OPS-003` | Incident drill. Given stage falla, when consulta por run_id, then causa localizable. | **NOT RUN** | PENDIENTE |
| `OPS-004` | Staging drill. Given release candidate, when rollout, then smoke y rollback verificados. | **NOT RUN** | PENDIENTE |

| `OPS-005` | Linux/Windows connectivity drills y revisión de hosting BSC.; Given caída VPN durante job activo, when falla inspección, then job no pasa a failed por desconexión. Given Windows con VPN sin ruta desde contenedor, then preflight reporta bloqueo. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
