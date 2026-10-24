# Seguridad

Este fork publica código fuente, pruebas, documentación y recursos gráficos. No distribuye credenciales, datos del equipo del mantenedor ni instaladores compilados. Cada persona compila la aplicación y conecta sus propias cuentas.

## Informar de un problema

Usa [Report a vulnerability](https://github.com/ed-gz/gentle-dot/security/advisories/new) para comunicar un problema en privado. Incluye el commit, el sistema operativo, los pasos mínimos y el impacto. Sustituye cualquier clave, mensaje personal, dirección privada o captura sensible por ejemplos ficticios. No publiques secretos en issues, comentarios o pull requests.

Este es un fork personal en desarrollo. Las correcciones se publican en `main`; no hay ramas de versiones anteriores con mantenimiento de seguridad garantizado. Si el problema también afecta a la base original, coordinaremos su comunicación con upstream sin publicar información sensible.

## Qué protege la publicación

- GitHub tiene activados el análisis de secretos y su protección de push. Son una capa adicional: no reconocen todos los secretos posibles.
- El workflow `Repository security` comprueba archivos y binarios prohibidos, tanto en el índice actual como en el historial, y ejecuta Gitleaks con sus reglas predeterminadas. No sube APKs, instaladores ni informes como artifacts.
- El hook opcional `pre-push` hace las mismas comprobaciones antes del envío. Debe activarse en cada clon; el workflow de GitHub por sí solo revisa contenido que ya se subió.
- `.gitignore` excluye credenciales, claves de firma, datos de ejecución y compilaciones locales. El guard revisa también lo añadido con `git add -f`.
- Las excepciones al análisis de secretos son dos fingerprints exactos del mismo token ficticio en una prueba histórica de upstream: su introducción y su fusión. No se excluyen carpetas de pruebas ni reglas completas. Los sprites y el Gradle wrapper verificado son recursos de construcción permitidos, no instaladores del producto.

Las reglas, sus comandos y la diferencia entre archivos locales y publicados están en [Higiene del repositorio](docs/repository-hygiene.md).

## Límites de la aplicación

La carpeta aislada del motor evita mezclar configuraciones; **no es una sandbox del sistema operativo**. En escritorio, el agente puede ejecutar comandos con los permisos de tu usuario. Las comprobaciones de comandos y aprobaciones reducen riesgos, pero no sustituyen la separación de cuentas o permisos del sistema.

La sesión local de GitHub CLI puede reutilizarse en escritorio mediante su ruta de configuración. No se copian sus tokens al repositorio ni a la carpeta aislada. `gh` conserva el acceso que ya tiene tu cuenta; el mecanismo no limita por sí mismo las operaciones a un solo repositorio. Una cuenta privada del motor o una configuración explícita tienen prioridad, y no se descubre automáticamente la cuenta del anfitrión en modo VPS. Consulta [GitHub](docs/github.md).

El teléfono se vincula por HTTPS privado con el equipo. El QR y los enlaces de vinculación son sensibles: no los publiques. El acompañante Android requiere permiso para mostrarse sobre otras aplicaciones; sus borradores locales se cifran con Android Keystore. Las respuestas del agente y los eventos nuevos del equipo siguen necesitando ese equipo conectado. No se incluye un servidor autónomo ni un servicio de push en la nube.

En Linux, el llavero de escritorio y otras credenciales accesibles al mismo usuario no equivalen a aislamiento frente a todos sus procesos. Los detalles de permisos y control del equipo están en [instalación](docs/install.md), [control de escritorio](docs/computer-control.md) y [diseño](docs/design.md).

## Si se publica una credencial real

Revócala o rótala primero en el proveedor. Borrarla del último commit no la elimina del historial, clones, cachés o forks. Revisa su uso y comunica el incidente por el canal privado; después prepara la retirada de los objetos afectados y coordina cualquier reescritura del historial con quienes usan el repositorio. Nunca pegues la credencial en el informe.
