# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `REL-001` | E2E real. Given proteína real autorizada, when recorrido, then datos no inventados. | **NOT RUN** | PENDIENTE |
| `REL-002` | Cache E2E. Given cache válido, when run repetida, then reuse; dado cambio de parámetro, then miss selectivo. | **NOT RUN** | PENDIENTE |
| `REL-003` | Regresión científica completa. Given outputs reales, when diff con baseline, then desvíos justificados. | **NOT RUN** | PENDIENTE |
| `REL-004` | Release checklist. Given release candidate, when sign-off, then matriz sin MUST huérfanos. | **NOT RUN** | PENDIENTE |

| `REL-005` | INS-01..INS-18, revisión independiente de permisos y evidencia del smoke read-only.; Given inspección MN5 aprobada, when se consultan archivos existentes, then no hay alteración atribuible. Given no autorización, then integración se marca BLOCKED/NOT RUN, no PASS ficticio. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
