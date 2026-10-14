# Matriz de verificación del inspector MN5 read-only

**Estado de corte:** 2026-10-14. Los casos con escrituras no se ejecutan sobre MN5; se prueban con mocks, inspección estática o SFTP de laboratorio aislado. Un `PASS local` no equivale a autorización ni aceptación remota de BSC.

| Caso | Input o condición | Resultado esperado | Evidencia / entorno | Estado |
| --- | --- | --- | --- | --- |
| INS-01 | `list('')` con permiso y VPN/SSH activos | Lista elementos directos de la raíz exacta | SFTP read-only MN5: 55 entradas, sin shell ni escritura; aprobación independiente pendiente | PARTIAL remoto |
| INS-02 | `stat('new/...')` existente | Devuelve metadata, sin escritura ni salida de root | `stat` sobre `benchmarks/multinode_baseline_47265106/summary.tsv` (81 bytes) en smoke read-only; snapshot SFTP verificó además `meta.json`, `dag_contracts.json`, `stages.tsv`, `summary.tsv` y `code_sha256.tsv` con tamaño/hash | PARTIAL remoto |
| INS-03 | Preview `.pdb/.cif/.mmcif/.tsv/.fasta` autorizado | Solo bytes hasta límite, sin modificación | Preview SFTP de TSV autorizado; whitelist, límite y rechazo de tipos cubiertos por tests locales | PARTIAL remoto / PASS local |
| INS-04 | `../`, `/etc`, prefijo hermano de root, `\`, `%2e%2e`, `%252e%252e` | Denegar por componentes y nunca abrir remoto | `validate_relative_path`, guardas de root y tests de traversal/encoding | PASS local |
| INS-05 | Symlink fuera del root, dentro del root o en componente padre | Denegar todos; sin follow_symlinks | Tests Local/SFTP fake y `assert_no_symlink_components`; no se creó symlink en MN5 | PASS local / remoto NOT RUN |
| INS-06 | Dotfiles, `.env`, passwords, SSH keys, special files | Denegar preview y no copiar bytes | Whitelist de previews, marcadores sensibles, dotfiles y tipos especiales cubiertos localmente | PASS local |
| INS-07 | Imagen/binario gigantes, directorios masivos, latencia SSH | Límites, paginación y timeout | Límites de entries/preview/result y errores de transporte cubiertos; benchmark de latencia no ejecutado | PARTIAL local |
| INS-08 | VPN offline/host inaccesible/SSH auth incorrecta | `REMOTE_UNAVAILABLE` o error explícito, no éxito ficticio | Fault injection de SSH/native `HPCTransportError` y auth errors; caída real no se provocó | PARTIAL local |
| INS-09 | `known_hosts` distinto o TLS VPN inválido | Fail-closed; sin excepción de seguridad | `RejectPolicy`, host-key tests y configuración fail-closed; TLS/VPN fault real NOT RUN | PARTIAL local |
| INS-10 | Invocar todos los métodos de ReadOnlyMN5Inspector | Solo operaciones `list/stat/realpath/lstat/open(rb)`; ninguna mutación ni remote exec | Interfaz separada, fake SFTP y tests de llamadas; smoke real fue SFTP sin shell | PASS local / PARTIAL remoto |
| INS-11 | DOS comandos `rm`, `mv`, `touch`, `sbatch` solicitados vía inspector | Método no disponible; request denegada sin invocar shell | El protocolo expone solo `list/stat/read_preview`; no existe endpoint de inspector ni método mutador | PASS local |
| INS-12 | Contenedores de desarrollo en Linux con VPN host | Preflight de conexión desde contenedor, sin `sudo` en app | VPN `ppp0`, SFTP y Compose VPN saludable; backend/worker no invocan `sudo` ni reciben `NET_ADMIN` | PARTIAL local/remoto |
| INS-13 | Docker Desktop/WSL2 en Windows con VPN host | Validar DNS/ruta desde contenedor; mock si no funciona | No ejecutado en Windows/WSL2 | NOT RUN |
| INS-14 | Estado metadata/hash antes y después de lectura | No cambia por operación de inspección | Inventario read-only before/after byte-identical; snapshot explícito de cinco metadatos sin fallos; sin operaciones mutadoras | PARTIAL remoto |
| INS-15 | Credenciales ausentes/logs/debug traces | No exponer password, root fuera de logs permitidos, datos secretos ni imprimir `.env` | Secret scan, tests de argv/host-key/password-file y errores sanitizados pasan localmente | PASS local / CI NOT RUN |
| INS-16 | Corrida CI sin BSC | Modo mock/test pasa offline sin claves, VPN, acceso GPFS ni SLURM_JOB_ID | Suite local 209 passed/11 skipped (los skips son PostgreSQL externo); workflow CI no ejecutado en proveedor | PASS local / CI NOT RUN |
| INS-17 | Dos rutas similares `/hilo_integrado_anotacion` y `/hilo_integrado_anotacion-extra` | Acceso solo a la primera por regla de componentes | Guardas lexicales/componentes y tests de root confinado | PASS local |
| INS-18 | Cambio de symlink/target entre chequeo y open | Diseño informa límite TOCTOU, falla cerrado en escenarios reproducibles | Descriptor-relative/no-follow nativo y metadata estable SFTP; ACL/TOCTOU real del servidor pendiente | PARTIAL local |

**No convertir los mocks en PASS de integración MN5.** Registro obligatorio: fecha UTC, commit, operador, sistema, versión herramienta, consentimiento/autorización, caso, resultado, hash/tamaño cuando aplique y ruta **relativa** (nunca secretos en evidencia). Nunca escribir/borrar/manipular archivos de la ruta del usuario para validar esta suite.
