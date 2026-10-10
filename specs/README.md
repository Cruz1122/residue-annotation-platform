# Spec-Driven Development del producto completo

Este formato Markdown portable se inspira en la [documentación oficial de GitHub Spec Kit](https://github.github.com/spec-kit/index.html) y el [schema `spec-driven` de OpenSpec](https://openspec.dev/docs/schemas/spec-driven). **No afirma ser un proyecto inicializado con la CLI de esas herramientas**; su metodología se puede adaptar a un agente genérico sin dos fuentes de verdad.

## Niveles y precedencia

- `constitution.md`: invariantes normativos.
- `PRODUCT.md`: comportamiento destino del producto completo.
- `contracts/`: interfaces transversales a respetar al implementar.
- `changes/NNNN-*/spec.md`: contrato del incremento; **único** scope de implementación cuando se aprueba ese change.
- `changes/NNNN-*/design.md`: diseño provisional de cómo cumplirlo, ajustable tras ADR.
- `changes/NNNN-*/tasks.md`: tareas implementables, trazadas a IDs de requisito.
- `changes/NNNN-*/acceptance.md`: evidencia PASS/FAIL/NOT RUN; la revisión documental remota puede figurar como `PARTIAL`, pero no sustituye la aceptación ejecutada.
- `TRACEABILITY.md`: matriz global que detecta MUST sin prueba.

El estado observable del checkout actual está resumido en [`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md). Sus evidencias locales no convierten los mocks en integración científica ni sustituyen los gates de MN5.

## Flujo

1. **Propuesta:** por qué, alcance, fuera de alcance, alternativas, dependencias.
2. **Specify:** cada `MUST` observable con `REQ-...` estable; escenario Given/When/Then positivo o negativo, incertidumbres explícitas.
3. **Clarify:** resolver decisiones que cambien arquitectura, seguridad, ciencia, API o test; registrar ADR. No suplir silencios inventando requisitos.
4. **Design:** cómo implementar, qué interfaces toca, modelos, riesgos, compatibilidad y rollback.
5. **Tasks:** tareas pequeñas por dependencia y trazabilidad requisito→prueba. No escribir features ficticias fuera de scope.
6. **Analyze:** consistencia entre contrato, tareas y pruebas, ausencia de requisitos huérfanos, presupuesto de test.
7. **Approve:** dueño humano firma un change, no todo el roadmap.
8. **Implement + Converge:** implementar solo change aprobado, probar, registrar resultados y corregir hasta cumplir el contrato; no marcar PASS si se omitió una prueba.

## Pruebas y evidencia

| Capa | Gate | Mock válido para esa capa | Equivale al producto final |
| --- | --- | --- | --- |
| Unit | Normalización, aa_ref, pipeline, estado, cache key | Sí | No por sí sola |
| API/DB | OpenAPI, Postgres, transacciones, errores, autorización | DB aislada/fixtures | No por sí sola |
| Frontend | Astro, select 3D, keyboard, WebGL, SSE recovery | PDB/mmCIF fixtures reales | No por sí sola |
| HPC | submit/status/cancel, manifest GPFS, recuperaciones | Fakes solo en desarrollo | **No** sin MN5 real |
| Ciencia | Comparación 18 stages, unidades, NA, coverage y QC | No para demostrar equivalencia | Sí, con baseline real |
| Seguridad/operación | IDOR, secretos, backup restore, incident drill | Staging aislado | Sí, con revisiones humanas |

El estado inicial de las 15 fases es `DRAFT` o `BLOCKED`, y sus pruebas ejecutables siguen `NOT RUN` salvo evidencias parciales explícitas. Medir desempeño con dataset/dispositivo definidos y presupuesto aprobado: no inventar valores de SLA/FPS.

## Layout por cambio

```text
specs/changes/NNNN-feature/
  proposal.md      # WHY y scope
  spec.md          # WHAT observable y REQ IDs
  design.md        # HOW, decisiones, tradeoffs, rollback
  tasks.md         # checklist enlazada a REQ IDs
  acceptance.md    # PASS/FAIL/NOT RUN y evidencia
```

## Validación documental

Ejecutar `python scripts/validate_specs.py` en este paquete (Python, sin dependencias externas). Comprueba estructura, IDs, tareas, aceptación y trazabilidad; **no** prueba que Astro/FastAPI/HPC funcionen.

## Inicio recomendado

Comenzar por `0001-repository-scaffold`; al aprobar y verificar ese cambio continuar con `0002`. La especificación del producto final permanece como objetivo; el primer commit no monta Postgres, worker, SSE ni HPC. La demo 3D tiene su propio change `0003`, y la integración molecular al producto ocurre en `0012`.

Fuentes metodológicas oficiales:

- https://github.github.com/spec-kit/index.html
- https://github.com/github/spec-kit
- https://openspec.dev/docs/schemas/spec-driven

## Inspección técnica read-only de datos MN5

En `0007` (baseline) y `0009` (HPC) se puede requerir inspección remota de archivos **ya existentes** para aclarar contratos científicos; se utilizará [`contracts/mn5-readonly-inspection.md`](contracts/mn5-readonly-inspection.md) y [`tests/mn5-readonly-inspection-matrix.md`](tests/mn5-readonly-inspection-matrix.md). El inventario de código de los 18 stages ya fue revisado por SFTP read-only y está en [`../docs/mn5-stage-code-inventory.md`](../docs/mn5-stage-code-inventory.md). Es un flujo de **agentes/operadores**, no una nueva feature de navegador web. Mocks son válidos para tests unitarios, pero no para decir que la ejecución BSC o la equivalencia científica se verificaron. El usuario debe confirmar autorización y credenciales locales; la spec no las incorpora ni las prueba automáticamente.

**Operación guiada:** [`runbooks/mn5-readonly-access.md`](runbooks/mn5-readonly-access.md). Su contenido no autoriza automáticamente conectarse ni utilizar credenciales personales sin control institucional.
