# Matriz de verificación del inspector MN5 read-only

**Todas las pruebas: `NOT RUN`.** Normativa: [`../contracts/mn5-readonly-inspection.md`](../contracts/mn5-readonly-inspection.md). Los casos con escrituras no se ejecutan sobre MN5; se prueban con mocks, inspección estática o SFTP de laboratorio aislado.

| Caso | Input o condición | Resultado esperado | Evidencia / entorno | Estado |
| --- | --- | --- | --- | --- |
| INS-01 | `list('')` con permiso y VPN/SSH activos | Lista elementos directos de la raíz exacta | MN5 solo lectura autorizada | NOT RUN |
| INS-02 | `stat('new/...')` existente | Devuelve metadata, sin escritura ni salida de root | MN5 lectura aprobada | NOT RUN |
| INS-03 | Preview `.pdb/.cif/.mmcif/.tsv/.fasta` autorizado | Solo bytes hasta límite, sin modificación | MN5 lectura aprobada | NOT RUN |
| INS-04 | `../`, `/etc`, prefijo hermano de root, `\`, `%2e%2e`, `%252e%252e` | Denegar por componentes y nunca abrir remoto | Unit/property test | NOT RUN |
| INS-05 | Symlink fuera del root, dentro del root o en componente padre | Denegar todos; sin follow_symlinks | SFTP lab fixture | NOT RUN |
| INS-06 | Dotfiles, `.env`, passwords, SSH keys, special files | Denegar preview y no copiar bytes | Unit/SFTP lab | NOT RUN |
| INS-07 | Imagen/binario gigantes, directorios masivos, latencia SSH | Límites, paginación y timeout | Unit/performance lab | NOT RUN |
| INS-08 | VPN offline/host inaccesible/SSH auth incorrecta | `REMOTE_UNAVAILABLE` o error explícito, no éxito ficticio | Fault injection | NOT RUN |
| INS-09 | `known_hosts` distinto o TLS VPN inválido | Fail-closed; sin excepción de seguridad | Seguridad lab | NOT RUN |
| INS-10 | Invocar todos los métodos de ReadOnlyMN5Inspector | Solo operaciones `list/stat/realpath/lstat/open(rb)`; ninguna mutación ni remote exec | SFTP spy | NOT RUN |
| INS-11 | DOS comandos `rm`, `mv`, `touch`, `sbatch` solicitados vía inspector | Método no disponible; request denegada sin invocar shell | Unit contract | NOT RUN |
| INS-12 | Contenedores de desarrollo en Linux con VPN host | Preflight de conexión desde contenedor, sin `sudo` en app | Linux dev con autorización | NOT RUN |
| INS-13 | Docker Desktop/WSL2 en Windows con VPN host | Validar DNS/ruta desde contenedor; mock si no funciona | Windows dev | NOT RUN |
| INS-14 | Estado metadata/hash antes y después de lectura | No cambia por operación de inspección | MN5 lectura aprobada | NOT RUN |
| INS-15 | Credenciales ausentes/logs/debug traces | No exponer password, root fuera de logs permitidos, datos secretos ni imprimir `.env` | Security lab | NOT RUN |
| INS-16 | Corrida CI sin BSC | Modo mock/test pasa offline sin claves, VPN, acceso GPFS ni SLURM_JOB_ID | CI | NOT RUN |
| INS-17 | Dos rutas similares `/hilo_integrado_anotacion` y `/hilo_integrado_anotacion-extra` | Acceso solo a la primera por regla de componentes | Unit test | NOT RUN |
| INS-18 | Cambio de symlink/target entre chequeo y open | Diseño informa límite TOCTOU, falla cerrado en escenarios reproducibles | Lab; OS ACL BSC pendiente | NOT RUN |

**No convertir los mocks en PASS de integración MN5.** Registro obligatorio: fecha UTC, commit, operador, sistema, versión herramienta, consentimiento/autorización, caso, resultado, hash/tamaño cuando aplique y ruta **relativa** (nunca secretos en evidencia). Nunca escribir/borrar/manipular archivos de la ruta del usuario para validar esta suite.
