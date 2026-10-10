# Acceptance 0002 — Quality gates

**Estado:** PARTIAL / NOT VERIFIED.  
**Bloqueador:** no hay pytest/Ruff/CI configurados y `0001` conserva divergencias de contrato.

| REQ | Comprobación | Esperado | Real | Estado |
| --- | --- | --- | --- | --- |
| REQ-QLT-001 | Ejecutar pytest | Health OK y ruta desconocida falla apropiadamente | No existe suite pytest en el checkout | NOT RUN |
| REQ-QLT-002 | Ejecutar Ruff lint/format check | Código 0 en ambos | Pendiente | NOT RUN |
| REQ-QLT-003 | Ejecutar Astro check/build | Código 0; regresiones causan fallo | `corepack pnpm check` y `corepack pnpm build` terminan con código 0 | PASS (frontend local) |
| REQ-QLT-003 | Ejecutar CI en proveedor real | Pipeline verde sobre branch válida | Pendiente | NOT RUN |
| REQ-QLT-004 | Inspeccionar jobs de CI | Ninguna dependencia HPC/secretos/GPU | `python -m compileall -q backend/app` y checks frontend locales no requieren MN5; CI no está presente | PARTIAL |

## Evidencia local

- `corepack pnpm check`: 0 errores, 0 warnings, 0 hints.
- `corepack pnpm build`: build estático completado; conserva warnings no bloqueantes de módulos externalizados/chunks grandes.
- `python -m compileall -q backend/app`: PASS.
- `python scripts/validate_specs.py`: PASS documental; no sustituye tests de producto.

**Veredicto:** controles frontend y compilación local parcialmente verificados; backend test/lint y CI siguen `NOT RUN`.
