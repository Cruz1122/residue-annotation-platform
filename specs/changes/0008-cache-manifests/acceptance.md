# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `CACHE-001` | Property key tests. Given resource hash distinto, when recalc cache_key, then cambia. | **NOT RUN** | PENDIENTE |
| `CACHE-002` | Fault injection. Given artifact perdido, when lookup, then cache miss. | **NOT RUN** | PENDIENTE |
| `CACHE-003` | Crash test. Given crash previo a manifest, when recovery, then no hay success parcial. | **NOT RUN** | PENDIENTE |
| `CACHE-004` | Audit review. Given stage success, when auditor revisa metadata, then reproduce origen. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
