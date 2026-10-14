# Specification 0003 — Selección molecular interactiva

**Estado:** blocked, no autorizado.  
**Objetivo:** demostrar interacción correcta con una estructura **real** en una feature aislada de Astro.

## Out of scope

Conexión al pipeline científico, inferencias automáticas, features de DB/worker/HPC y datos de anotación ficticios.

### REQ-VIZ-001 — Visualización real de estructura

**MUST:** el usuario puede cargar un PDB o mmCIF de referencia y visualizar su conformación tridimensional, sin datos geométricos inventados.

- **Given** estructura de prueba válida, **When** se abre la demo, **Then** se muestra el modelo molecular correspondiente.

### REQ-VIZ-002 — Selección trazable por residuo

**MUST:** al seleccionar un residuo en la vista 3D, se presenta la identidad de estructura disponible (modelo, cadena, residuo, inserción si aplica) y una señal visual inequívoca. La selección desde una lista/rango, si se incluye, debe sincronizarse con la escena.

- **Given** un residuo real, **When** se selecciona con puntero, **Then** vista y panel muestran la misma entidad.
- **Given** un residuo con insertion code, **When** se selecciona, **Then** no se confunde con otro que comparte número de autor.

### REQ-VIZ-003 — Mapping canónico honesto

**MUST:** si se muestra `aa_position` canónica, debe existir una correspondencia verificada con la secuencia de referencia y `aa_ref`; si no existe, UI debe indicar «posición canónica no disponible» y mostrar solo numeración estructural.

- **Given** mapping validado, **When** se selecciona residuo, **Then** reporta posición canónica correcta.
- **Given** ausencia de mapping, **When** se selecciona residuo, **Then** no deriva canónico = número PDB sin comprobar.

### REQ-VIZ-004 — Fallos explícitos

**MUST:** una estructura ausente, corrupta, no compatible o sin selección válida debe producir mensajes comprensibles; no congelar la UI ni afirmar éxito.

- **Given** fichero inválido, **When** se intenta cargar, **Then** aparece error y puede reintentarse con una entrada válida.

### REQ-VIZ-005 — Biblioteca elegida con evaluación reproducible

**MUST:** antes de elegir biblioteca definitiva, documentar 2 o más alternativas relevantes, soporte de PDB/mmCIF, selección por residuo, actualización de highlights, bundle/integración Astro y un benchmark con estructura de prueba. Métricas de rendimiento y dispositivo definidos antes de medir.

- **Given** dos bibliotecas candidatas, **When** se evalúan con caso comparable, **Then** queda registrada una decisión técnica fundamentada.

## Restricciones

- Sin GPU HPC: renderizado en el cliente.
- No crear biblioteca de WebGL propia.
- Selección por residuo **no** equivale a predicción de función, energía, patogenicidad o confianza AF3.
- No inventar umbrales FPS o latencia antes de escoger dispositivo y dataset.

## Bloqueadores

`OPEN-VIZ-001`, `OPEN-VIZ-002`, `OPEN-VIZ-003` deben cerrarse antes de aprobar `design.md` final. `0003` no forma parte del scaffolding.
