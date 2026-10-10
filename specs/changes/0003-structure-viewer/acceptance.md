# Acceptance 0003 — Visor

**Estado:** PROTOTYPE EVIDENCE / NOT VERIFIED.  
**Bloqueadores:** no hay benchmark, fixture mmCIF ambigua, mapping canónico validado ni suite E2E.

| REQ | Observación requerida | Resultado real | Estado |
| --- | --- | --- | --- |
| REQ-VIZ-001 | Render de PDB/mmCIF real en browser | Mol* carga el PDB local `P01130_model_0.pdb`; no se ha probado mmCIF ni un fichero remoto/real autorizado | PARTIAL (PDB mock) |
| REQ-VIZ-002 | Selección visual + panel de identidad consistente | Click en el botón de secuencia `1 M` mostró el panel `Anotaciones` para `M MET · Metionina 1`; la anotación está marcada `MOCK` | PARTIAL (browser local) |
| REQ-VIZ-003 | Correspondencia canónica validada o explícitamente ausente | El código usa `auth_seq_id` y una resta directa para el índice; no existe mapping PDB/mmCIF↔canónico validado | NOT RUN |
| REQ-VIZ-004 | Fichero inválido con error recuperable | Pendiente | NOT RUN |
| REQ-VIZ-005 | ADR con alternativas, entorno y benchmark | Mol* está incorporado como dependencia; no existe benchmark/ADR de selección | PARTIAL |

## Evidencia local

- `frontend/src/features/annotations/components/viewer/ProteinViewer.jsx` crea el visor Mol* y sincroniza selección de secuencia con loci estructurales.
- `frontend/src/features/proteins/data/protein.js` apunta a la fixture local PDB de P01130.
- En `http://localhost:4742/proteins/P01130/viewer/` se observaron 860 posiciones de la cadena A, modos de color y panel de anotaciones mock.

**Veredicto:** existe un spike/prototipo visual funcional; no es aceptación del visor científico ni resuelve ADR-003.
