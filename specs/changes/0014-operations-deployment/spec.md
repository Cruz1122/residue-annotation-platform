# 0014 — Operaciones, recovery y despliegue

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Operar en entorno autorizado con recuperación de jobs, backups y observabilidad.

**No objetivos:** Sin afirmar que Compose sea stack de producción HPC.

### REQ-OPS-001 — Recovery

MUST: reinicio de worker reanuda seguimiento sin hacer doble submit.

- **Escenario verificable:** Given worker cae, when restart, then reconcilia job_id.
- **Prueba prevista:** Chaos test.

### REQ-OPS-002 — Backup restaurable

MUST: PostgreSQL y referencias de artifacts tienen plan de backup/restore ensayado.

- **Escenario verificable:** Given snapshot, when restore aislado, then runs legibles.
- **Prueba prevista:** Restore drill.

### REQ-OPS-003 — Observabilidad

MUST: log/metrics correlacionan run, stage y job con fallo sin filtrar secretos.

- **Escenario verificable:** Given stage falla, when consulta por run_id, then causa localizable.
- **Prueba prevista:** Incident drill.

### REQ-OPS-004 — Despliegue controlado

MUST: staging/producción pueden desplegar, migrar y revertir según plan aprobado.

- **Escenario verificable:** Given release candidate, when rollout, then smoke y rollback verificados.
- **Prueba prevista:** Staging drill.

### REQ-OPS-005 — Operación multiplataforma VPN/SSH y modo nativo aprobado

MUST: Los runbooks MUST diferenciar desarrollo Linux/Windows local con VPN host + SSH password y producción sobre servicio BSC persistente autorizado, con modo mock offline y fallos VPN recuperables sin atribuir fallos a jobs en Slurm.

- **Escenario verificable:** Given caída VPN durante job activo, when falla inspección, then job no pasa a failed por desconexión. Given Windows con VPN sin ruta desde contenedor, then preflight reporta bloqueo.
- **Prueba prevista:** Linux/Windows connectivity drills y revisión de hosting BSC.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0010`, `0011`, `0013`.
- Resolver ADR relevante antes de decisiones irreversibles.
