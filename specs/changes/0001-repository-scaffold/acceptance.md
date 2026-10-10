# Acceptance 0001 — Scaffold

**Estado:** PARTIAL / VERIFIED LOCALLY, con divergencias respecto al contrato objetivo.  
**Commit verificado:** `e3c69c8`.  
**Entorno:** Linux local, Docker Compose 5.6.0, Node 22.22.3, Python 3.14.7.

## Registro de verificación

| REQ | Comprobación | Esperado | Resultado real | Estado |
| --- | --- | --- | --- | --- |
| REQ-SCF-001 | Inspección del árbol y servicios | Layout por features; sin DB/worker | `README.md`, `.env.example`, `compose.yml`, `frontend/`, `backend/` y fronteras por feature presentes; no hay DB/worker/HPC | PASS (local) |
| REQ-SCF-002 | `curl -i http://localhost:8742/api/v1/health` | HTTP 200 y JSON `status=ok` | HTTP 200, `content-type: application/json`, `{"status":"ok"}` | PASS (local) |
| REQ-SCF-003 | Abrir `http://localhost:4742` | `Connected` con backend arriba | La página inicial renderiza onboarding mock; `getHealth()` existe pero no es consumido por la UI | FAIL (divergencia) |
| REQ-SCF-004 | Parar backend y recargar frontend | `Unavailable` sin crash | No hay estado de health conectado a la página inicial | FAIL (no implementado) |
| REQ-SCF-004 | Simular respuesta JSON inválida de health | `Unavailable` | No ejecutado; UI de health no está conectada | NOT RUN |
| REQ-SCF-005 | `docker compose config --services` | Exactamente `frontend`, `backend` | Salida exacta: `backend`, `frontend` | PASS (local) |
| REQ-SCF-005 | `docker compose up --build -d` | Arranque real; puertos 4321/8000 | Arranque real en los puertos actuales `4742/8742`; contrato objetivo usa otros puertos | PARTIAL (divergencia) |
| REQ-SCF-006 | Inspección CORS, URL y `.env.example` | Orígenes explícitos; cero secretos | CORS explícito para `http://localhost:4742` y `.env` ignorado; API base está hardcodeada y no existen `APP_ENV`/`APP_NAME` | PARTIAL |
| REQ-SCF-007 | Seguir README desde checkout limpio | Reproduce arranque y chequeo | README documenta Compose, URLs, health, estructura y exclusiones; no documenta el flujo `Connected/Unavailable` exigido por el change | PARTIAL |

## Guía de comandos (M0, fuera de HPC)

- `docker compose config --services`: comprueba servicios **sin ejecutarlos**; detecta servicios extra.
- `docker compose up --build`: construye las imágenes y arranca los dos contenedores; hacerlo con Docker disponible y puertos libres.
- `curl -i http://localhost:8000/api/v1/health`: inspecciona status HTTP, headers y cuerpo del backend.
- `docker compose stop backend`: deja Astro activo para comprobar el estado negativo. Después `docker compose start backend` restablece el backend.
- `docker compose down`: detiene y elimina contenedores/red creados por esta composición; no usar `-v` si existiera data persistente ajena.

Documentación oficial: [Docker Compose CLI](https://docs.docker.com/compose/reference/), [Astro](https://docs.astro.build/), [FastAPI](https://fastapi.tiangolo.com/).

## Evidencia adicional

- `docker compose up --build -d` creó ambos contenedores; `docker compose ps` mostró los dos servicios `Up`.
- `curl --fail-with-body --include http://localhost:8742/api/v1/health` devolvió `HTTP/1.1 200 OK` y `{"status":"ok"}`.
- `curl --fail-with-body --include http://localhost:4742/` devolvió `HTTP/1.1 200 OK` y la página de onboarding.
- `frontend/src/features/runs/components/onboarding/OnboardingFlow.jsx` implementa una carga simulada y persiste sesión local; no es una ingesta backend.

## Hallazgos

El scaffold local existe, pero `REQ-SCF-003`, `REQ-SCF-004` y parte de `REQ-SCF-006` siguen sin cumplir el contrato objetivo. No declarar el change completamente verificado hasta resolver esas divergencias.
