# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `REL-001` | E2E real. Given proteína real autorizada, when recorrido, then datos no inventados. | **NOT RUN** | PENDIENTE |
| `REL-002` | Cache E2E. Given cache válido, when run repetida, then reuse; dado cambio de parámetro, then miss selectivo. | **NOT RUN** | PENDIENTE |
| `REL-003` | Regresión científica completa. Given outputs reales, when diff con baseline, then desvíos justificados. | **NOT RUN** | Existe evidencia read-only de `all_stages_47143345` con 15 etapas `success` y una `failed` (`conformational_ensemble`, `returncode=1`) sólo en nivel 1; no hay outputs/manifests completos, resolución del fallo ni comparación golden reproducible. |
| `REL-004` | Release checklist. Given release candidate, when sign-off, then matriz sin MUST huérfanos. | **NOT RUN** | PENDIENTE |

| `REL-005` | INS-01..INS-18, revisión independiente de permisos y evidencia del smoke read-only.; Given inspección MN5 aprobada, when se consultan archivos existentes, then no hay alteración atribuible. Given no autorización, then integración se marca BLOCKED/NOT RUN, no PASS ficticio. | **PARTIAL** | El 2026-10-14 el inspector real sólo leyó el root autorizado; listó 55 entradas, hizo `stat`/preview de un TSV de 81 bytes y el inventario previo/posterior fue byte-identical. El smoke local adicional recorrió Compose por login, proteína, run terminal, SSE, visor sin estructura e información sin evidencia; no sustituye la matriz INS completa, aprobación independiente ni la ejecución científica. |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
