# Proposal 0003 — Demo de estructura PDB/mmCIF con selección de residuos

**Status:** blocked — no pertenece al scaffold.  
**Depends on:** `0002` verificado y selección de biblioteca aprobada.  
**Milestone:** M2.

## Why

La plataforma busca explorar proteínas a escala de residuo y seleccionar regiones específicas de modelos estructurales. Una demo dedicada permite validar interacciones, mapeos e impacto de rendimiento antes de conectar los resultados científicos.

## What changes

Un visor 3D molecular interactivo encapsulado como feature frontend, con selección por cadena/residuo y reporte de la selección. Cargar al menos una estructura real licenciada/redistribuible apropiadamente (local o enlace verificable) sin depender de HPC.

## Out of scope

Interpretación clínica, predicción estructural, pipeline AF3, anotaciones científicas calculadas, GPU HPC, manejo de runs reales, backend de artefactos definitivo, motor de visualización propio.

## Riesgos

- El residuo canónico `aa_position` y los identificadores de un PDB/mmCIF no siempre son idénticos.
- Las grandes estructuras pueden bloquear la UI; no fijar librería por popularidad sin medir un caso representativo.
- No prometer selección canónica si falta la tabla de correspondencia.

## Open questions

- `OPEN-VIZ-001`: ¿Qué modelo(s) de prueba autorizados/representativos se usarán (tamaño, cadena, resolución, formato)?
- `OPEN-VIZ-002`: ¿Se necesita solo selección de residuo estructural o mapping biológico canónico ya en la demo?
- `OPEN-VIZ-003`: ¿Qué dispositivo/navegador y presupuesto de rendimiento representa el uso real?

## Approval

- [ ] Hitos previos verificados
- [ ] Dataset y mapeo definidos
- [ ] Benchmark/requisitos acordados
- [ ] Implementación de `0003` autorizada
