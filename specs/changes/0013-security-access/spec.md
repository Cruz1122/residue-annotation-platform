# 0013 — Identidad, autorización y cuotas HPC

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Controlar quién accede a proteínas, runs, artefactos y cómputo costoso.

**No objetivos:** No elegir proveedor SSO sin política BSC ni asumir datos públicos por default.

### REQ-SEC-001 — Authz por recurso

MUST: backend verifica permisos por user/proyecto en lectura, creación, descarga y cancelación.

- **Escenario verificable:** Given A y B, when B solicita run privada de A, then deniega sin metadata.
- **Prueba prevista:** Tests IDOR.

### REQ-SEC-002 — Sin secretos

MUST: tokens/HPC keys/GPFS paths no aparecen en logs, HTML ni API.

- **Escenario verificable:** Given carga de run, when inspección, then sin secrets.
- **Prueba prevista:** Secret scan.

### REQ-SEC-003 — Cuotas aprobadas

MUST: límites autorizados de tamaño, tasa, uso HPC y expiración se aplican server-side.

- **Escenario verificable:** Given cuota excedida, when create run, then no submit.
- **Prueba prevista:** Quota tests.

### REQ-SEC-004 — Auditoría

MUST: acciones relevantes registran actor/recurso/acción/tiempo sin datos sensibles innecesarios.

- **Escenario verificable:** Given cancel, when audit, then entry trazable.
- **Prueba prevista:** Audit tests.

### REQ-SEC-005 — Gobierno de inspección GPFS de solo lectura

MUST: El sistema MUST limitar inspección de desarrollo a raíz GPFS autorizada, exigir permiso explícito a agentes/operadores, rechazar traversal/symlinks y evitar distribución de credenciales/secretos o exposición a la UI; cuenta personal no representa permiso OS read-only.

- **Escenario verificable:** Given usuario no autorizado o ruta externa, when solicita inspección, then fail-closed sin abrir remoto. Given credencial revocada, then ninguna operación alternativa la elude.
- **Prueba prevista:** INS-04..INS-11, INS-15, threat model/ADR-013.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0004`, `0005`, `0011`.
- Resolver ADR relevante antes de decisiones irreversibles.
