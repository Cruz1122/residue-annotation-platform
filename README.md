<h1 align="center">residue-annotation-platform</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Astro-5-FF5D01?logo=astro&logoColor=white&style=flat" alt="Astro 5" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white&style=flat" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white&style=flat" alt="FastAPI 0.115+" />
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white&style=flat" alt="Python 3.12" />
</p>

Plataforma para anotar residuos de proteínas. Este repositorio es un monorepo con un frontend en Astro y una API en FastAPI.

## Estructura

```text
residue-annotation-platform/
├── README.md
├── compose.yml
├── frontend/
│   └── src/
│       ├── pages/
│       ├── layouts/
│       ├── features/
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

```bash
docker compose up --build
```

| Servicio | URL |
| --- | --- |
| Frontend | http://localhost:4742 |
| API | http://localhost:8742 |
| OpenAPI | http://localhost:8742/docs |
| Health | http://localhost:8742/api/v1/health |

La página inicial consulta `GET /api/v1/health` a través de `frontend/src/shared/api/client.ts` y muestra el estado del backend.