# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Checklist de implementación

- [ ] T-0004-01 — Crear modelos protein/protein_identifier y migración (`REQ-PROT-001`)
- [ ] T-0004-02 — Implementar hash y validadores con property tests (`REQ-PROT-002`)
- [ ] T-0004-03 — Crear endpoints POST/GET y tests DB (`REQ-PROT-003`)
- [ ] T-0004-04 — Revisar normalización/concurrencia y errores (`REQ-PROT-004`)

## Gate

Ejecutar aceptación de `PROT-001, PROT-002, PROT-003, PROT-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
