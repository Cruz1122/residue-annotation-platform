# 0007 — Baseline y reconciliación científica

**Estado:** DRAFT — NO APROBADO — implementación local parcial; baseline científico NOT RUN; contratos y evidencia read-only PARTIAL. **Fase:** F3 Ciencia. **Dependencias:** `0002`.

## Checklist de implementación

- [ ] T-0007-01 — Crear baseline P01130 con outputs/hashes (`REQ-SCI-001`)
- [ ] T-0007-02 — Resolver ADR de nombres y reglas científicas (`REQ-SCI-002`)
- [x] T-0007-02a — Implementar comparador conservador de tablas y tolerancias explícitas (`REQ-SCI-002`) — reporta diferencias reproducibles sin convertir el diff en aprobación científica; falta ejecutarlo contra el baseline real
- [x] T-0007-03 — Documentar contratos de los 18 stages (`REQ-SCI-003`) — fichas contrastadas con código/contratos MN5; baseline científico todavía pendiente
- [ ] T-0007-04 — Comparar resultados reales antes de aprobar migración (`REQ-SCI-004`)

- [x] T-0007-005 — Evidencia científica remota obtenida sin modificación; trazar a `REQ-SCI-005` y contrato de inspección MN5 — inventario before/after y snapshot read-only de cinco metadatos verificados; `summary.tsv` sólo tiene encabezado y los outputs completos/diff científico siguen pendientes

## Gate

Ejecutar aceptación de `SCI-001, SCI-002, SCI-003, SCI-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
