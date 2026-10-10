# Contrato de visualización molecular y selección — DRAFT

El visor emplea biblioteca WebGL especializada a seleccionar después de benchmark (Mol* es candidato, no decisión cerrada). Renderizar moléculas **reales** desde PDB/mmCIF, sin fabricar coordenadas.

**Identidad estructural completa:** modelo, entidad, cadena, `label_seq_id`, `auth_seq_id`, insertion code y altloc cuando corresponda. `auth_seq_id`, `label_seq_id` y `aa_position` no se igualan implícitamente. Un mapping a posición canónica sólo se publica si concuerda contra referencia y `aa_ref`; en ambiguos se indica `mapping unavailable` en lugar de adivinar.

**Sincronización:** 3D ↔ secuencia ↔ tabla per-residue ↔ tracks de anotación ↔ panel de evidencia. Permitir selección única y de rangos/conjuntos con estado visible, color/leyenda, reset de selección y navegación de cámara; decidir interacciones y límites en change 0012.

**Semántica:** NA ≠ 0; etapas running/failed/success distinguidas; pLDDT no interpretado como estabilidad/función/patogenicidad; topología TM independiente de calidad de coords. Se muestran origen, unidad, qc, provenance cuando existen.

**Benchmark requerido:** al menos dos bibliotecas, misma estructura/cadena/residuo, mismo navegador/hardware, carga, memoria, selección, bundle y rendering/latencia; fixtures con insertion codes, múltiples cadenas, coordenadas ausentes y modelos alternativos. No fijar umbrales de FPS inventados.

**Accesibilidad/degradación:** navegación por teclado de selección vía tabla, mensajes de fallo si WebGL no disponible, alternativas textuales; la ausencia de GPU WebGL no elimina acceso a anotaciones.
