# 0007 — Baseline y reconciliación científica

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL; baseline y aceptación científica NOT RUN. **Fase:** F3 Ciencia. **Dependencias:** `0002`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Congelar evidencia científica existente antes de cualquier refactor de los 18 stages.

**No objetivos:** No cambiar algoritmos, thresholds, unidades ni requerir corrida completa al crear la spec.

### REQ-SCI-001 — Baseline reproducible

MUST: stage migrado tiene fixture, versiones, hashes, parámetros y outputs de referencia trazables.

- **Escenario verificable:** Given stage real, when smoke, then se puede comparar con baseline.
- **Prueba prevista:** Artefactos reales + manifest.

### REQ-SCI-002 — Equivalencia comprobada

MUST: migration conserva significado o registra change científico independiente.

- **Escenario verificable:** Given before/after, when compara, then diferencias/tolerancias reportadas.
- **Prueba prevista:** Diff científico.

### REQ-SCI-003 — Identidad de residuo

MUST: aa_position 1-based y aa_ref concordante en cada merge.

- **Escenario verificable:** Given residuo con aa_ref distinto, when merge, then falla.
- **Prueba prevista:** Negative residue mapping.

### REQ-SCI-004 — Separación topología/confianza

MUST: baja confianza AF3 no borra TM concluyente ni prueba patogenicidad.

- **Escenario verificable:** Given TM de evidencia concluyente con pLDDT bajo, when P5, then mantiene decisión biológica salvo conflicto especificado.
- **Prueba prevista:** Golden P5.

### REQ-SCI-005 — Evidencia científica remota obtenida sin modificación

MUST: Para reconciliar etapas y artefactos reales, el agente MUST usar el contrato de inspección de solo lectura dentro de la raíz BSC, sin modificar ningún archivo ni ejecutar el pipeline desde ese acceso.

- **Escenario verificable:** Given carpeta real disponible y autorización, when inspecciona contratos/logs/manifests, then conserva evidencias por lectura. Given credenciales no disponibles, then NOT RUN sin inventar outputs.
- **Prueba prevista:** Revisión del inspector y comparación de metadata de archivos antes/después (solo operaciones de lectura).

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0002`.
- Resolver ADR relevante antes de decisiones irreversibles.
