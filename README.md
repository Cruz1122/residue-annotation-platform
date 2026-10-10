<h1 align="center">residue-annotation-platform</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Astro-7-FF5D01?logo=astro&logoColor=white&style=flat" alt="Astro 7" />
  <img src="https://img.shields.io/badge/Preact-10-673AB8?logo=preact&logoColor=white&style=flat" alt="Preact 10" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white&style=flat" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white&style=flat" alt="FastAPI 0.115+" />
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white&style=flat" alt="Python 3.12" />
</p>

Plataforma para anotar residuos de proteínas. Este repositorio es un monorepo con un frontend en Astro y una API en FastAPI.

El plan completo del producto y sus contratos SDD están en [`ROADMAP.md`](ROADMAP.md) y [`specs/`](specs/). Esos documentos describen el objetivo incremental; no certifican que el pipeline científico o la integración con MN5 estén implementados. El estado actual de la conexión y del perímetro documentado de MN5 está en [`docs/mn5-current-state.md`](docs/mn5-current-state.md); el inventario del código real de stages observado por SFTP está en [`docs/mn5-stage-code-inventory.md`](docs/mn5-stage-code-inventory.md).

El estado de implementación observado en el checkout, incluyendo qué prototipos mock tienen evidencia local y qué gates siguen pendientes, está resumido en [`specs/IMPLEMENTATION-STATUS.md`](specs/IMPLEMENTATION-STATUS.md).

## Estructura

```text
residue-annotation-platform/
├── README.md
├── compose.yml
├── frontend/
│   ├── public/
│   │   ├── mock/
│   │   └── mock-artifacts/
│   └── src/
│       ├── pages/
│       ├── layouts/
│       ├── features/
│       │   ├── annotations/
│       │   ├── artifacts/
│       │   ├── proteins/
│       │   ├── runs/
│       │   └── stages/
│       └── shared/
└── backend/
    └── app/
        ├── main.py
        ├── core/
        ├── features/
        └── infrastructure/
```

El código futuro vive por feature (`proteins`, `runs`, `stages`, `annotations`, `artifacts`), no en carpetas globales de routers, services o models. `core/` e `infrastructure/` marcan las fronteras de configuración transversal, HPC y almacenamiento. Esas carpetas están vacías a propósito: un archivo aparece cuando tiene una función real.

## Cómo levantarlo

El frontend requiere Node.js 22.12.0 o superior y usa pnpm como gestor obligatorio.

```bash
cd frontend
corepack pnpm install
corepack pnpm dev
```

Para levantar ambos servicios:

```bash
docker compose up --build
```

| Servicio | URL |
| --- | --- |
| Frontend | http://localhost:4742 |
| API | http://localhost:8742 |
| OpenAPI | http://localhost:8742/docs |
| Health | http://localhost:8742/api/v1/health |

## Rutas del frontend

| Ruta | Propósito |
| --- | --- |
| `/` | Onboarding mock para cargar PDB/FASTA y seleccionar variantes opcionales |
| `/proteins/` | Biblioteca de proteínas |
| `/proteins/P01130/progress/` | Pipeline interactivo |
| `/proteins/P01130/viewer/` | Visor Mol* con secuencia, selección y modos de color |
| `/proteins/P01130/info/` | Anotaciones por etapa y artefactos descargables |

La UI de proteínas es deliberadamente mock y está preparada para sustituir sus fuentes de datos por la API sin rehacer la composición visual: contratos y datos viven en las carpetas de cada feature, mientras las páginas y layouts solo ensamblan las superficies. El cliente base de API se conserva en `frontend/src/shared/api/client.ts` para la integración progresiva del backend.

## Especificaciones y MN5

La suite de especificaciones se puede validar estáticamente con:

```bash
python scripts/validate_specs.py
```

Este comando valida la estructura documental, la trazabilidad y los estados `NOT RUN`; no ejecuta el producto, no abre conexiones y no prueba MN5.

El perfil `HPC_*` está disponible como plantilla en [`.env.example`](.env.example). Sus rutas `PASSWORD_FILE` son referencias a secretos externos y no deben rellenarse con contraseñas dentro del repositorio. En el estado actual esas variables todavía no son consumidas por FastAPI: la VPN, SSH/SFTP, GPFS, Slurm y la supervisión de jobs forman parte de cambios posteriores del roadmap.

Validación local del frontend:

```bash
cd frontend
corepack pnpm check
corepack pnpm build
corepack pnpm preview
```
