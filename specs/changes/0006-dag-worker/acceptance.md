# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `EXEC-001` | Integration restart. Given worker activo y web reiniciado, when consulta, then estado preservado. | **NOT RUN** | PENDIENTE |
| `EXEC-002` | Prueba unitaria del pipeline. Given rama fallida y hermana independiente, when avanza, then sólo descendientes afectados se bloquean. | **NOT RUN** | PENDIENTE |
| `EXEC-003` | Test Postgres concurrente. Given workers concurrentes, when claim, then uno solo adquiere lease. | **NOT RUN** | PENDIENTE |
| `EXEC-004` | Test cancelación. Given cancel solicitado, when worker lee, then no agenda nuevos stages. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
