# Design 0001 — Organización y arranque mínimo

**Status:** propuesta de diseño, no implementación.

## Estructura propuesta

```text
residue-annotation-platform/
├── README.md
├── .gitignore
├── .env.example
├── compose.yml
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── astro.config.mjs
│   ├── tsconfig.json
│   └── src/
│       ├── pages/index.astro
│       ├── layouts/BaseLayout.astro
│       ├── features/{proteins,runs,annotations,artifacts}/
│       └── shared/{api,components,config,styles,types}/
└── backend/
    ├── Dockerfile
    ├── pyproject.toml
    └── app/
        ├── main.py
        ├── core/config.py
        ├── features/health/router.py
        ├── features/{proteins,runs,stages,annotations,artifacts}/
        └── infrastructure/{hpc,storage}/
```

Las carpetas vacías de capacidades futuras se mantienen con `.gitkeep` cuando Git lo requiera. **No** introducir en ellas `service.py`, `repository.py`, `models.py` u otro código sin uso. Los `__init__.py` necesarios para imports Python sí son aceptables.

## Frontend

- Astro en modo desarrollo dentro del contenedor, escuchando en `0.0.0.0:4321` para acceso desde el host.
- `pages/index.astro` renderiza contenedor y mensaje inicial `Checking…` o equivalente; código browser-side consulta `getHealth()`.
- `shared/api/client.ts` posee la URL `PUBLIC_API_BASE_URL`, construye `/health`, comprueba `response.ok`, valida mínimamente el JSON y lanza error en caso contrario.
- UI traduce éxito en `Connected` y error en `Unavailable`; no mostrar éxito antes de resolver la petición.
- URL expuesta al navegador debe ser `http://localhost:8000/api/v1` en contexto de desarrollo local con el navegador en el host; usar `backend:8000` **solo** para comunicación interna entre contenedores si algún cambio la necesita más adelante.

## Backend

- FastAPI en `app/main.py`, router de health en `app/features/health/router.py`; prefijo `/api/v1` declarado una vez.
- `app/core/config.py` mantiene APP_NAME/APP_ENV/CORS_ORIGINS; configuración básica sin DB.
- Una lista controlada de orígenes permite `http://localhost:4321`; no wildcard de CORS con credenciales.
- Backend accesible desde fuera del contenedor en `0.0.0.0:8000`.

## Compose

Dos servicios únicamente: `frontend`, `backend`. Dockerfiles independientes, contextos de build correctos, sin DB ni worker. Publicar puertos `4321:4321` y `8000:8000`. Usar `.env.example` como plantilla; la puesta en marcha explicada debe usar un `.env` de desarrollo real copiado o defaults seguros coherentes. Elegir una sola estrategia y documentarla; no exigir extras silenciosos después de `docker compose up --build`.

## Decisiones de dependencia

- Mantener el backend simple: Python 3.12, FastAPI, Uvicorn; `pydantic-settings` opcional si evita parsing manual sin sobrecargar el scaffold. Ninguna dependencia de base de datos.
- Astro y TypeScript configurados por herramientas oficiales del proyecto; dependencias y lockfile generados por gestor real, no escritos a mano.
- Evitar React/Vue/Svelte salvo necesidad de interacción demostrada en una spec posterior.

## Validación y rollback

Verificar syntax/import, `docker compose config`, levantamiento real, `GET /health`, navegador con API activa e inactiva, README. Desmontar solo los servicios/volúmenes de desarrollo de este proyecto; no tocar datos de pipelines existentes. Si build o check falla, reportar error sin relajar contratos.

## Decisiones diferidas

Persistencia, modelo de secuencia, upload, PDB, SSR de Astro, worker y observabilidad operativa se deciden en changes futuros, no aquí.
