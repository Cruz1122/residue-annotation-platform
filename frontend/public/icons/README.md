# Protein icon pack V5 — corrección del icono de proteína

72 SVG: 19 etapas/ClinVar + 53 UI. Los otros 71 iconos se han copiado de V4 **sin modificar un byte**.

## Corrección solicitada

Antes: `ui/protein.svg` era un dibujo manual que no reproducía la imagen mostrada.
Ahora: `ui/protein.svg` se extrajo **directamente** del PNG original `ícono_minimalista_de_proteína_plegada.png`.

Trazado reproducible por Python/OpenCV, sin generación de imágenes ni salida bitmap embebida:

1. PNG transparente original de 1254×1254 (SHA-256: `8d6c578aef1d9db6f8f33982f47a39cf3464fd591ad173566d32cef3d62a493e`).
2. Umbral de alfa ≥ 127 para suprimir ruido de transparencia. Componente conexa principal, sin alterar la estructura.
3. `skimage.measure.find_contours` conserva los límites de la figura y los huecos internos mediante contornos de nivel alfa.
4. `cv2.approxPolyDP(epsilon=0.2)` conserva una versión de alta fidelidad; otra con epsilon 0.8 px reduce vértices para el icono UI.
5. Cada contorno se escribe como subtrazado de un único `<path>` con `fill-rule="evenodd"`; sin `<image>` y sin raster en el SVG.
6. Se conservan dos precisiones del mismo contorno real. Única adaptación geométrica: escalado proporcional y centrado en `viewBox="0 0 24 24"`.

## Auditoría

- Resolución del PNG: 1254×1254; contornos detectados: 11; vértices del trazado fiel: 4415; vértices optimizados: 565.
- Correspondencia de silueta del trazado de alta fidelidad con PNG fuente (intersección/unión, máscara alfa ≥ 127): **0.97289**.
- Correspondencia del icono UI optimizado con trazado fiel, en snapshots vectoriales: **1.00000 a 24 px** y **0.99026 a 128 px**.
- En rasterización para validación de 128 px: bbox = `(16, 13, 111, 115)`; lado visible mayor: **102 px**, centro óptico = (63.5, 64.0).
- `ui/protein.svg`: color sólido aproximado al color original `#14202f`.
- `svg_currentColor/protein.svg`: mismo contorno, hereda CSS `currentColor`.
- `protein_trace_high_fidelity.svg`: variante vectorial de máxima fidelidad, 24×24, **no es un icono adicional**.
- `protein_source_trace.svg`: contorno original en coordenadas 1254×1254 para auditoría; **no es un icono adicional**.
- Se usa `fill` y no `stroke`: los grosores salen del contorno real de la imagen. No se inventan líneas.

## Estructura

- `stages/`: 19 SVG científicos.
- `ui/`: 53 SVG generales.
- `svg_currentColor/`: 53 variantes de tema.
- `contact_sheet_all_72.svg`: lámina SVG de los 72 iconos.
- `preview.html`: previsualización SVG a 16, 24, 32, 64 y 128 px.
- `manifest.json`: rutas, hashes, procedencia y datos QA.
- `pixel_audit.csv`: medidas de dimensiones por icono.
- `integration_map.json`: conserva las rutas y claves del frontend sin renombrarlas.

**Nota de autoría:** el trazado procede de una imagen generada anteriormente en la conversación. En este trabajo no se ha generado una imagen nueva ni se ha redibujado la proteína. No representa un modelo estructural PDB específico.
