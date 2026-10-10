# Specification 0001 — Scaffold ejecutable

**Estado:** proposed.  
**Precondición:** entorno local con Docker Engine/Compose para verificación; no requiere Slurm ni GPU.  
**Objetivo:** demostrar una integración mínima real Astro ↔ FastAPI, organizada por features y levantable por Compose.

## In scope

Árbol monorepo, dos apps reales, health, presentación web real de health, configuración local segura y README reproducible.

## Out of scope

DB, auth, worker, SSE, rutas del dominio científico, viewer molecular, orquestación, HPC, pipeline o despliegue productivo.

## Requisitos y escenarios

### REQ-SCF-001 — Estructura inicial por features

**MUST:** el repo contiene `README.md`, `.gitignore`, `.env.example`, `compose.yml`, `frontend/`, `backend/`. El frontend dispone de `src/features/` y `src/shared/`; el backend dispone de `app/features/`, `app/core/` y `app/infrastructure/` como fronteras de organización, sin capas globales técnicas obligatorias ni servicios ficticios.

- **Given** un checkout limpio, **When** se inspeccionan archivos, **Then** están las rutas requeridas y no se encuentra código inventado para DB/worker/HPC.

### REQ-SCF-002 — Health backend inequívoco

**MUST:** `GET /api/v1/health` responde HTTP 200 con `Content-Type` JSON y payload exactamente equivalente a `{"status":"ok"}`.

- **Given** backend funcionando, **When** se hace GET a `/api/v1/health`, **Then** status 200 y `status=ok`.
- **Given** ruta inexistente, **When** se hace GET, **Then** no se devuelve la respuesta de health como fallback universal.

### REQ-SCF-003 — Señal frontend basada en respuesta real

**MUST:** la página inicial de Astro muestra el nombre del producto y `Connected` **solo** cuando la llamada browser-side al backend completa con éxito HTTP y la respuesta satisface `status=ok`.

- **Given** frontend y backend disponibles, **When** se abre `http://localhost:4321`, **Then** se observa estado `Connected` tras consultar el endpoint real.
- **Given** una respuesta válida, **When** se recarga, **Then** la UI vuelve a consultar el estado, no lo conserva como una constante.

### REQ-SCF-004 — Manejo explícito de indisponibilidad

**MUST:** si falla la red, hay HTTP no exitoso o JSON sin `status=ok`, la UI no presenta `Connected`; muestra `Unavailable` y no genera un error no controlado de interfaz.

- **Given** backend detenido, **When** se abre/recarga la UI, **Then** aparece `Unavailable`.
- **Given** payload inválido, **When** se procesa, **Then** aparece `Unavailable`.

### REQ-SCF-005 — Compose mínimo y funcional

**MUST:** `docker compose up --build` levanta **exactamente** dos servicios (`frontend` y `backend`). Astro se escucha en el host en el puerto 4321 y FastAPI en 8000. No se requiere preinstalar Node ni paquetes Python en el host para el camino Docker.

- **Given** Docker/Compose funcionando y puertos libres, **When** se ejecuta `docker compose up --build`, **Then** ambos servicios permanecen arriba y responden en sus URLs.
- **Given** Compose configurado, **When** se revisa `docker compose config --services`, **Then** lista exclusivamente `frontend` y `backend`.

### REQ-SCF-006 — Configuración explícita y sin secretos

**MUST:** API base para el navegador configurable mediante `PUBLIC_API_BASE_URL`, backend con origen permitido de desarrollo y `APP_ENV`/`APP_NAME` básicos. El `.env.example` no contiene credenciales reales; `.env` no se versiona. CORS permite origen `http://localhost:4321` y no usa `*` para todos los orígenes sin justificación.

- **Given** variables documentadas, **When** se inicia el proyecto con valores de ejemplo, **Then** Astro puede alcanzar la API.
- **Given** inspección estática, **When** se leen Compose y archivos de config, **Then** no hay secretos reales ni URL de backend hardcodeada en componentes.

### REQ-SCF-007 — Documentación de onboarding reproducible

**MUST:** `README.md` explica alcance, requisitos de Docker/Compose, preparación de `.env`, arranque/parada, URLs, prueba de health, estructura por features, errores comunes y funcionalidades excluidas.

- **Given** una persona con el repo limpio, **When** sigue el README, **Then** puede iniciar ambos servicios y observar health sin conocimientos del pipeline científico.

## Nonfunctional y limitaciones

- Python 3.12 como base de backend y TypeScript strict en frontend.
- Health no debe afirmar que existe conexión a PostgreSQL o al HPC.
- Evitar solicitudes de red externas para descargar modelos científicos al iniciar; la construcción de dependencias estándar sí podrá usar repositorios de paquetes.
- Sin objetivos de rendimiento artificiales en este hito.
- No definir autenticación ni contrato de datos per-residue en este cambio.

## Contratos

| Interfaz | Entrada | Salida/resultado | Fallo |
| --- | --- | --- | --- |
| `GET /api/v1/health` | sin parámetros | `200 {"status":"ok"}` | errores HTTP convencionales si servidor no disponible |
| `PUBLIC_API_BASE_URL` | URL HTTP absoluta para **browser** | prefijo usado por `getHealth()` | UI `Unavailable` si no es accesible |
| Inicio Compose | `docker compose up --build` | frontend y backend activos | código/log de Docker diagnóstico, no health simulado |

## Acceptance mapping

REQ-SCF-001 → árbol y revisión de alcance; 002 → petición HTTP; 003–004 → navegador con backend arriba/abajo + respuesta inválida; 005 → Compose y URLs; 006 → revisión variables/CORS; 007 → recorrido del README. Evidencias en `acceptance.md`.
