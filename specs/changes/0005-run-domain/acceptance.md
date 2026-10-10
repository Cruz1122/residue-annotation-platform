# 0005 — Runs, stages, resultados y artefactos

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0004`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `RUN-001` | Contrato API + test DB. Given protein válida, when POST run, then queda pending en DB y devuelve ID. | **NOT RUN** | PENDIENTE |
| `RUN-002` | Test FK/reuse. Given dos runs reutilizando cálculo, when se consulta, then comparten stage_result sin copia de artefactos. | **NOT RUN** | PENDIENTE |
| `RUN-003` | State machine tests. Given stage success, when se intenta pasar a running sin retry, then rechaza. | **NOT RUN** | PENDIENTE |
| `RUN-004` | API negativos. Given run inexistente, when GET, then 404 sin inventar progreso. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
