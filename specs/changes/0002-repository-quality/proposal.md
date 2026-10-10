# Proposal 0002 — Quality gates del monorepo

**Status:** blocked — requiere M0 verificado y aprobación humana.  
**Depends on:** `0001-repository-scaffold` verificado.  
**Milestone:** M1.

## Why

Después de contar con apps mínimas funcionales, hace falta impedir que cambios futuros rompan la integración en silencio. La solución es introducir comprobaciones pequeñas y reproducibles sobre **código que existe**, no construir infraestructura de producto.

## What changes

Tests mínimos del health/backend, comprobaciones de estilo y tipos, scripts de desarrollo explícitos, CI sin cluster y documentación para contribuir.

## Out of scope

Persistencia, e2e scientific runs, pruebas GPU, worker, viewer, Slurm, GPFS, autenticación, hardening de producción, observabilidad externa.

## Riesgos y alternativas

- Evitar pipelines CI que requieran credenciales o `salloc`.
- Evitar hacer depender toda validación local de Docker si las comprobaciones de Python y Astro pueden ser puras.
- **Alternativa descartada:** suite end-to-end amplia antes de contar con features reales.

## Open questions

- `OPEN-QLT-001`: ¿Qué proveedor de CI se usa (GitHub Actions si el repo vive en GitHub)? Resolver antes de implementar ese archivo.

## Approval

- [ ] `0001` verificado
- [ ] Proveedor CI decidido
- [ ] `0002` aprobado, sin permiso para implementar `0003`
