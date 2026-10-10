# Design 0003 — Visor molecular (exploratorio)

**Estado:** DRAFT / BLOCKED. No se ha escogido librería ni benchmark.

## Arquitectura propuesta

- `frontend/src/features/structure-viewer/`: island interactiva y lógica de selección, separada de otras features.
- `frontend/src/shared/api/`: uso futuro de endpoint de artefactos solo cuando exista un contrato real. Para demo se admite estructura de prueba estática y atribuida.
- Adapter de biblioteca limitado a cargar, destacar, seleccionar, limpiar selección y liberar recursos; no crear interfaz abstracta antes de evaluar que realmente la necesita.
- Estado de selección definido en términos de `modelId`, `chainId`, identificadores de residuo de la estructura, `insertionCode` cuando proceda, y `canonicalPosition?` **solo cuando el mapping esté validado**.

## Alternativas candidatas

Evaluar **Mol\***, **3Dmol.js** y/o **NGL Viewer** a partir de sus APIs y licencias vigentes, sin afirmar aún ganador. Comparar carga, soporte PDB/mmCIF, selección por átomo/residuo, highlights, destrucción de canvas, integración browser-only con Astro y tamaño/carga percibida.

## Experimento y decisiones

1. Elegir un dataset de referencia, su procedencia y política de distribución.
2. Establecer equivalencia de condiciones de carga y navegador.
3. Instrumentar tiempo a primera estructura interactiva, latencia de selección y memoria cuando pueda medirse razonablemente.
4. Hacer 3 ejecuciones o más si la variabilidad lo exige, documentando entorno y límites de la medición.
5. Elegir biblioteca con ADR breve. No interpretar benchmark puntual como verdad general.

## Riesgos de mapeo

Los identificadores `auth_seq_id`, `label_seq_id`, cadena, modelo y códigos de inserción de mmCIF/PDB no son sinónimos de `aa_position` canónica. La demo puede omitir `canonicalPosition` si todavía no se puede asegurar la correspondencia. Nunca llenar huecos con extrapolación silenciosa.

## Rollback

Eliminar exclusivamente la feature de visor y assets de demo de este cambio; preservar M0/M1.

## Límite de la inspección técnica

La inspección opcional de carpetas MN5 en las specs de desarrollo **no exige una UI de exploración de GPFS**, endpoints GET arbitrarios ni acceso SSH del navegador. La visualización molecular del producto consume artefactos autorizados por su ID o fixtures aprobados. El acceso técnico de agentes por VPN+SSH+SFTP solo lectura se rige por `specs/contracts/mn5-readonly-inspection.md`.
