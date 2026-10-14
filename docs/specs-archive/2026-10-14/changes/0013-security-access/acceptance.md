# 0013 — Identidad, autorización y cuotas HPC

**Estado:** PARTIAL local — aceptación externa pendiente. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `SEC-001` | Tests IDOR. Given A y B, when B solicita run privada de A, then deniega sin metadata. | **PASS local / aprobación externa pendiente** | El escenario HTTP/Bearer independiente contra el backend real de Compose con PostgreSQL 16 creó la proteína y la run de Alice y confirmó `403` para Bob en ambos recursos; la respuesta extranjera no expuso `/gpfs/` ni `storage_key`. Falta la aprobación independiente del gate. |
| `SEC-002` | Secret scan. Given carga de run, when inspección, then sin secrets. | **PASS local / proveedor pendiente** | `python scripts/secret_scan.py` terminó `secret scan: PASS`; el workflow del proveedor todavía no se ha ejecutado. |
| `SEC-003` | Quota tests. Given cuota excedida, when create run, then no submit. | **PARTIAL local** | Hay límites server-side de upload, CPU/GPU, inflight stages y slots por usuario con pruebas locales/PostgreSQL; falta una prueba de cuota operativa aprobada y un submit Slurm real. |
| `SEC-004` | Audit tests. Given cancel, when audit, then entry trazable. | **PASS local** | `test_runs.py` y `test_uploads.py` verifican auditoría de create/cancel/upload sin payload científico, y la suite PostgreSQL pasa. |

| `SEC-005` | INS-04..INS-11, INS-15, threat model/ADR-013.; Given usuario no autorizado o ruta externa, when solicita inspección, then fail-closed sin abrir remoto. Given credencial revocada, then ninguna operación alternativa la elude. | **PARTIAL local/remoto** | El [threat model](../../../../../docs/security-threat-model.md) documenta activos, límites, amenazas T-01..T-10 y controles; paths, symlinks, secretos, preview/list bounds, factory con habilitación explícita y errores sanitizados tienen cobertura local; smoke SFTP real fue read-only y el inventario permaneció idéntico. Aprobación BSC y la matriz completa siguen pendientes. |

## Registro de ejecución obligatorio

- Fecha UTC: 2026-10-14
- Commit/release: `e65b705` (verificación local; no es sign-off externo)
- Comando/entorno/exit code: `uv run pytest -q` → 209 passed/11 skipped; la ejecución completa PostgreSQL 16 dio 220 passed; `python scripts/secret_scan.py` → PASS
- Logs/artefactos/capturas: no se registraron secretos ni rutas absolutas en respuestas públicas
- Evaluación científica/operacional: controles de aplicación e inspector parcial; Slurm/SSO/proveedor externo NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
