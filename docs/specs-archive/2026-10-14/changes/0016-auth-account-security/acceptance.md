# 0016 — Autenticación, sesiones y límite de ejecución por usuario

**Estado:** PENDING / PARTIAL local. Los contratos, roles, pantallas y pruebas locales existen; Resend real, SSO y SCP MN5 siguen `NOT RUN`. Secret scan local pasa. Los escenarios de concurrencia PostgreSQL para rotación de refresh, refresh-vs-logout, bucket de rate limit, slots, claims, último administrador y cancel-vs-finalize pasan en PostgreSQL 16 aislado.
**Fecha de verificación local:** 2026-10-14.

| REQ | Evidencia local | Estado de aceptación |
| --- | --- | --- |
| AUTH-001 | register + verify-email con token one-shot, token sólo en development/test, plantillas HTML/text y adaptador Resend simulado en pruebas | PARTIAL local / entrega real NOT RUN |
| AUTH-002 | login, access JWT, refresh rotation, replay rejection, logout (full-session con Bearer + invalidación de access vía token_version; single-session con refresh) y tests PostgreSQL de rotación/revocación | PASS local, incluida concurrencia PostgreSQL |
| AUTH-003 | Bearer dependency, `/me`, ownership y fallback de headers sólo en development/test; en producción el gateway debe inyectar ambos headers o falla cerrado | PARTIAL local |
| AUTH-004 | reset-password one-shot y change-password con invalidación de sesiones, serializados por lock de usuario | PASS local |
| AUTH-005 | rate-limit persistido por IP, por IP agregada y por cuenta, `429/Retry-After`, `audit_events` sin raw secrets y test PostgreSQL de carrera de bucket | PASS local, incluida concurrencia PostgreSQL |
| AUTH-006 | `active_run_slots` único por usuario, 409 durante run activa, liberación terminal y test PostgreSQL de creación concurrente | PASS local, incluida concurrencia PostgreSQL |
| AUTH-007 | uploads bounded FASTA/PDB/mmCIF, ownership, asociación a run y frontera SCP confinada con rechazo de symlinks padre | PARTIAL local / SCP real NOT RUN |

## Comandos locales

    uv run pytest -q                                  # 209 passed, 11 skipped (sin PostgreSQL externo)
    POSTGRES_TEST_DATABASE_URL=... uv run pytest -q   # 220 passed (PostgreSQL 16 aislado)
    uv run ruff check app alembic tests
    uv run ruff format --check app alembic tests

Resultado local actual: 209 pruebas de backend PASS y los 11 escenarios concurrentes pasan en la ejecución completa de 220 tests contra PostgreSQL 16 aislado; incluyen roles, revocación de sesiones, invalidación de reset tokens, logout de familias rotadas, último administrador, plantillas/adaptador Resend simulado, ingestión remota simulada, claims de polling, recuperación de leases, restart del entrypoint real, reintento ante configuración HPC no disponible, recuperación de submission receipts SSH/native sin doble submit, selección explícita del inspector read-only, reuso de cache, paginación, ownership PostgreSQL HTTP/Bearer, streaming desde descriptor verificado y fronteras SCP/HPC nativo. La asociación de uploads usa lock de fila y `test_upload_cannot_be_attached_to_a_second_run_after_terminal_release` evita reusar un input ya asociado; `prepare_run_inputs` comprueba tamaño/hash del artifact antes de transferir y marca una alteración como fallo sin abrir SCP/native. El runtime reconstruido aceptó y descargó un FASTA bounded de 43 bytes y el mmCIF real de `structure_modeling` (569,213 bytes) con hash coincidente; la regresión del parser cubre manifests con loops de metadata antes de `_atom_site`. El contrato remoto de uploads mantiene una frontera PDB-only porque el CLI MN5 observado no acepta mmCIF: la ruta usa la accesión científica, el UUID de run sólo aísla el subdirectorio y el job exporta `PIPELINE_SELECTED_FASTA/PDB`; la extensión incompatible falla cerrado antes de abrir SCP. El commit `e65b705` conserva explícitos en Compose los límites de secuencia/upload, rate limits y expiraciones de tokens, añade healthcheck HTTP para que el frontend espere al backend saludable, receipts de submission para recuperar jobs tras una respuesta perdida, publicación SCP/native mediante temporal + no-replace publish y mantiene `RESEND_API_KEY` sólo en el backend; la configuración de Compose fue introducida en `760956e`. `python scripts/secret_scan.py` pasa. La suite cubre dos principales con Bearer en PostgreSQL, pero no demuestra entrega real de email, SSO, proveedor CI, threat model ni transferencia SCP contra MN5.

## Gates pendientes

- IDOR independiente con dos principals sobre PostgreSQL.
- Recuperación de slots huérfanos con un proceso worker real reiniciado: cubierta localmente; falta repetir en staging/Slurm aprobado.
- Entrega real de Resend con dominio verificado, además de expiración/revocación y política de enumeración revisada.
- Threat model, rotación de `AUTH_JWT_SECRET`, observabilidad y ejecución del secret scan en el proveedor CI.
- SCP autorizado contra un entorno real, con host key verificada y archivo pequeño aprobado.

**No marcar `PASS` global sin esas evidencias.**
