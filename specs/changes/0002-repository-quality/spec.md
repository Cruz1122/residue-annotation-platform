# Specification 0002 — Controles de calidad

**Estado:** blocked. **Depende de:** M0 verificado.  
**Objetivo:** que una contribución nueva pueda verificar rápidamente que no rompió el scaffold.

## Out of scope

No crear features de negocio, modelos de DB, endpoints nuevos, workers ni contenedores extra.

### REQ-QLT-001 — Test backend mínimo

**MUST:** existe al menos un test automatizado del endpoint health exitoso y otro que compruebe que una ruta no reconocida no responde con el payload de health.

- **Given** entorno de test aislado, **When** se ejecuta el conjunto Python, **Then** todos los tests reales terminan correctamente.
- **Given** ruta inexistente, **When** se prueba, **Then** no se confunde con health válido.

### REQ-QLT-002 — Formato y lint reproducibles

**MUST:** backend tiene comandos reproducibles de `ruff check` y `ruff format --check`. Frontend define un check estándar de proyecto. El README documenta el comportamiento y código de error de los checks.

- **Given** checkout limpio, **When** se ejecutan comandos documentados, **Then** salen 0 sin reescritura silenciosa del código.

### REQ-QLT-003 — Checks frontend y automatización CI

**MUST:** el frontend ofrece verificación TypeScript/Astro y build; un workflow CI invoca checks adecuados para ambos proyectos y falla si alguno falla, en un proveedor elegido explícitamente.

- **Given** un PR, **When** corre la CI, **Then** detecta errores de Python y del build/types de Astro.
- **Given** una regresión detectable, **When** ejecuta el check, **Then** el job falla, no se marca verde por `continue-on-error`.

### REQ-QLT-004 — Validación independiente del cluster

**MUST:** lint, tests, types, builds y CI de esta fase no requieren conectarse a MareNostrum, disponer de GPU, secretos HPC ni `SLURM_JOB_ID`.

- **Given** una máquina ordinaria compatible con dependencias del scaffold, **When** ejecuta checks, **Then** no se intenta `sbatch`, `salloc`, descargar modelos científicos ni montar GPFS.

## Condiciones de cierre

Cada requisito debe registrar comandos, resultado y entorno en `acceptance.md`. Un CI definido sin haber corrido en el proveedor elegido todavía deja esa parte como `NOT RUN`.
