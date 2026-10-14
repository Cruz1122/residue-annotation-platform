# Design 0002 — Quality gates austeros

**Status:** diseñado como propuesta; no implementado.

## Opciones técnicas

- Backend: `pytest` + un cliente de pruebas FastAPI, `ruff check` y `ruff format --check`.
- Frontend: `astro check` / `astro build` con scripts en `package.json`; añadir `@astrojs/check` cuando el comando lo necesite.
- CI: proveedor del repo, preferentemente GitHub Actions **si** el hosting es GitHub. Configurar job Python y job Node por separado o uno compacto si el coste es menor.
- Dependencias y versiones: generarlas con gestores reales y locks resueltos, no archivos ficticios.

## Propiedades de diseño

- Test de health sin servicios externos.
- No construir fixtures SQL sin DB.
- No añadir imágenes GPU ni contenedores de pipelines científicos.
- Jobs con exit code real; no `|| true`, no desactivar fallos para aparentar verde.
- Logs y outputs CI útiles, sin secretos.

## Verificación

Ejecutar suite local y, después, comprobar CI en plataforma real. El test de una ruta inexistente es contrafactual mínimo para garantizar que health no es un catch-all. Si falta CI remota, registrar `NOT RUN`; no simularla.

## Rollback

Retirar workflow y configuración de checks en PR revertible; preservar scaffold ya aprobado.
