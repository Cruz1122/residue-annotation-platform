# 0012 — Explorer 3D + secuencia + anotaciones

**Estado:** PROTOTYPE EVIDENCE / NOT VERIFIED. **Fase:** F5 Experiencia. **Dependencias:** `0003`, `0010`, `0011`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `UX-001` | E2E con fixture real. Given run validada, when click en 3D, then panel muestra posición y aa_ref correctos. | **PARTIAL** | Visor local mostró `M MET · Metionina 1` y anotaciones `MOCK`; no hay run validada ni backend |
| `UX-002` | E2E bidireccional. Given residuo con mapping, when selección en tabla, then 3D destaca el mismo. | **PARTIAL** | Existe código de sincronización secuencia↔Mol* y se probó selección de secuencia; mapping científico sigue sin validar |
| `UX-003` | UI/QC tests. Given evidencia ausente, when selecciono residuo, then UI NO muestra 0. | **NOT RUN** | La pantalla está alimentada por `mockAnnotations`; no prueba ausencia de evidencia real |
| `UX-004` | A11Y + benchmark. Given teclado, when elegir residuo, then se muestra texto/selección sincronizada. | **PARTIAL** | Los residuos son botones accesibles y se observaron 860 posiciones; no hay auditoría A11Y ni benchmark |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

## Evidencia local

- `http://localhost:4742/proteins/P01130/progress/` renderizó 18 nodos y el contador `0 de 18 pasos`.
- `http://localhost:4742/proteins/P01130/info/` renderizó 18 paneles y 56 enlaces de artefactos mock.
- `ProteinViewer.jsx` integra Mol*, selección por secuencia/3D y temas de color; `viewer.js` etiqueta explícitamente las anotaciones como mock.
- No existen endpoints de runs/anotaciones, SSE, autorización, descarga server-side ni datos científicos MN5 conectados.

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
