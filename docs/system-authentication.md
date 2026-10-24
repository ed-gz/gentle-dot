# Instalar Chromium con autenticación del equipo

Gentle Dot puede solicitar la instalación de Chromium y dejar que **el sistema operativo pida la contraseña en la computadora**. La contraseña no se envía al chat, al modelo, al servidor de Dot ni al teléfono. En el teléfono verás que hace falta autenticarte en el equipo.

La autenticación administrativa se completa en el diálogo de Linux en la computadora. Introducir esa contraseña desde el teléfono todavía no está implementado.

## Preparar una instalación desde el código

Los paquetes Linux de Gentle Dot incluyen el auxiliar del sistema. Si ejecutas una copia del repositorio, prepara e instala ese auxiliar una sola vez:

```bash
cd /path/to/gentle-dot
node scripts/package/build-system-helper.mjs
sudo /usr/bin/bash scripts/linux/install-system-helper.sh "$PWD/build/system-helper"
```

El primer comando sólo compila los archivos y sus comprobaciones de integridad. El segundo los instala como `root:root`; solicita la contraseña en la terminal del equipo. **Estos pasos no instalan Chromium.** El instalador no se ejecuta automáticamente al construir la APK y no recibe contraseñas como argumento.

Luego abre la nueva aplicación de escritorio de Gentle Dot. El servidor debe haber sido iniciado por esa aplicación para disponer de su canal privado. Un servidor independiente o una versión anterior de escritorio no puede abrir este diálogo mediante el canal nuevo.

## Usarlo

1. Pide a Dot instalar Chromium cuando lo necesite para navegar.
2. Revisa la solicitud de instalación y autentícate en el diálogo del sistema en la computadora.
3. Dot muestra el resultado cuando termina el gestor de paquetes.

Las confirmaciones habituales de Dot pueden responderse desde el teléfono. Si esa misma solicitud estaba abierta en el escritorio, su ventana se cierra; otras solicitudes conservan su propio estado. Esto no sustituye la autenticación administrativa del sistema.

Puedes cancelar mientras el sistema espera la autenticación. Una instalación ya iniciada debe terminar para evitar dejar incompleta la base de datos del gestor de paquetes. Si desconectas Dot antes de autenticarte, la solicitud pendiente se cancela.

## Qué está permitido

| Sistema | Operación fija |
|---|---|
| Arch y derivados, incluido CachyOS | Instalar el paquete `chromium` con `pacman` |
| Debian | Instalar el paquete `chromium` con `apt-get` |
| Fedora | Instalar el paquete `chromium` con `dnf` |
| Otros sistemas, incluido Ubuntu | Se informa que esta instalación no está disponible |

El auxiliar no acepta comandos, rutas, paquetes alternativos ni contraseñas del agente. No añade repositorios ni hace una actualización general del equipo. Requiere `pkexec`, un agente gráfico de autenticación de polkit activo y los repositorios habituales del sistema funcionando.

Los archivos instalados son `/usr/libexec/gentle-dot/privileged-helper` y `/usr/share/polkit-1/actions/dev.gentledot.install-browser.policy`. La aplicación verifica que esos archivos y sus carpetas pertenezcan a root y que otros usuarios no puedan modificarlos. La política pide autenticación administrativa en cada operación; no guarda una autorización abierta.

Si el gestor de paquetes falla, revisa su estado en la computadora y vuelve a solicitar la instalación cuando esté listo. Dot no intenta corregir bloqueos del gestor matando procesos ni amplía la operación solicitada.

La separación entre aplicación y autenticación sigue el mecanismo oficial de [pkexec y polkit](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html).
