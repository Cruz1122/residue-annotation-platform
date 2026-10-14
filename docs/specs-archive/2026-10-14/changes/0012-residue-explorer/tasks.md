# 0012 — Explorer 3D + secuencia + anotaciones

**Estado:** DRAFT — NO APROBADO — integración local PARTIAL; se conserva la UI existente y quedan pendientes E2E científico, auditoría A11Y formal y benchmark. **Fase:** F5 Experiencia. **Dependencias:** `0003`, `0010`, `0011`.

## Checklist de implementación

- [x] T-0012-01 — Mantener las páginas proteins/runs y estado global existentes (`REQ-UX-001`) — onboarding, catálogo, progreso y consultas reales están conectados al backend.
- [x] T-0012-02 — Conectar visor y mapping validado (`REQ-UX-002`) — Mol* consume artefactos publicados y no infiere mapping ausente.
- [x] T-0012-03 — Mantener tracks/tablas y sincronización (`REQ-UX-003`) — la vista consume filas/units publicados y conserva estados pending/failed/NA.
- [ ] T-0012-04 — Ensayar fallos WebGL, NA, teclado y performance (`REQ-UX-004`)

## Gate

Ejecutar aceptación de `UX-001, UX-002, UX-003, UX-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
