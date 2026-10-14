# 0016 — Autenticación, sesiones y límite de ejecución por usuario

**Estado:** DRAFT — PENDING ACCEPTANCE — NO APROBADO. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Contrato de comportamiento (WHAT)

### REQ-AUTH-001 — Registro y verificación

MUST: `POST /api/v1/auth/register` crea una cuenta con password derivada, email normalizado y estado no verificado. `POST /api/v1/auth/verify-email` consume un token de un solo uso y permite login posterior. Las respuestas de producción no exponen el token raw.

### REQ-AUTH-002 — Login y sesiones

MUST: `POST /api/v1/auth/login` sólo acepta credenciales válidas y email verificado. Emite access token Bearer corto y refresh token opaco persistido. `POST /api/v1/auth/refresh` rota el refresh token; un token usado, revocado o expirado no puede reutilizarse. `POST /api/v1/auth/logout` con Bearer válido revoca todas las sesiones e invalida los access tokens emitidos (bump de `token_version`); con sólo refresh token revoca esa sesión.

### REQ-AUTH-003 — Middleware y autorización

MUST: el middleware/dependency Bearer valida firma, expiración, tipo, versión de sesión y usuario activo. `/auth/me`, proteins, runs, uploads y artifacts aplican ownership server-side. Producción no acepta el fallback de headers salvo configuración de gateway explícita.

### REQ-AUTH-004 — Cambio y recuperación de password

MUST: `POST /auth/change-password` exige password actual y revoca sesiones previas. `POST /auth/reset-password` no enumera cuentas y `POST /auth/reset-password/confirm` consume un token expirado/one-shot y revoca sesiones.

### REQ-AUTH-005 — Rate limits y auditoría

MUST: registro, login, refresh, verificación y reset están limitados server-side con respuesta `429` y `Retry-After`. Acciones de auth relevantes registran actor, acción, recurso, tiempo e IP sin password/token raw.

### REQ-AUTH-006 — Una proteína simultánea por usuario

MUST: una cuenta no puede crear una segunda run mientras exista otra run no terminal. La reserva se adquiere en la misma transacción que la run mediante una restricción única; al finalizar/cancelar la run se libera.

### REQ-AUTH-007 — Inputs pequeños para una run

MUST: `POST /api/v1/uploads` acepta únicamente FASTA o PDB/mmCIF pequeños, valida extensión/contenido/tamaño, guarda con clave generada y permisos privados, y permite asociar como máximo un input de cada tipo a una run. El worker puede transferirlos por SCP sólo con perfil SSH explícito y path remoto generado dentro del root configurado.

## Restricciones

- Tokens y hashes se almacenan separados del contenido raw.
- El navegador nunca recibe rutas filesystem/GPFS ni comandos SCP.
- El inspector MN5 read-only no puede reutilizarse para uploads o mutaciones.
- La aceptación de proveedor email/SSO, CI externa, IDOR HTTP/Bearer independiente con dos principals PostgreSQL, SCP MN5 real y threat model queda pendiente. Los tests PostgreSQL de rotación, revocación, bucket de rate limit, slots, claims y ownership service-level están implementados y pasan en una base aislada.
