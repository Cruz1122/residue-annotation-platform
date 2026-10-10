# 0013 — Identidad, autorización y cuotas HPC

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `SEC-001` | Tests IDOR. Given A y B, when B solicita run privada de A, then deniega sin metadata. | **NOT RUN** | PENDIENTE |
| `SEC-002` | Secret scan. Given carga de run, when inspección, then sin secrets. | **NOT RUN** | PENDIENTE |
| `SEC-003` | Quota tests. Given cuota excedida, when create run, then no submit. | **NOT RUN** | PENDIENTE |
| `SEC-004` | Audit tests. Given cancel, when audit, then entry trazable. | **NOT RUN** | PENDIENTE |

| `SEC-005` | INS-04..INS-11, INS-15, threat model/ADR-013.; Given usuario no autorizado o ruta externa, when solicita inspección, then fail-closed sin abrir remoto. Given credencial revocada, then ninguna operación alternativa la elude. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
