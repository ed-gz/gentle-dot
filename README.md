# Gentle Dot — fork con Android, orquestación y Capri opcional

Este es el fork de [Eduardo Garza (`ed-gz`)](https://github.com/ed-gz/gentle-dot) de [Gentle Dot](https://github.com/Gentleman-Programming/gentle-dot), creado por Gentleman Programming. Conserva el asistente, la rosa y la identidad de Gentle Dot, y añade trabajo en sesiones remotas, mejoras de chat, integración Linux y un cliente Android. **Capri es un tema y una personalidad opcionales; una instalación nueva empieza con Gentle Dot.**

El repositorio contiene código fuente, pruebas y recursos gráficos. **Los APK y demás instaladores se construyen localmente; no están incluidos en Git.** Esta guía describe el fork. El [registro de cambios](docs/fork-changelog.md) separa sus aportaciones de la base upstream y enlaza los detalles de cada área.

## Empezar desde el código

Necesitas Git, **Node.js 24** y **pnpm 11.5.0**, la versión fijada en `package.json`. Si ya tienes Node 24 y te falta pnpm, puedes instalarlo con `npm install --global pnpm@11.5.0`.

```sh
git clone https://github.com/ed-gz/gentle-dot.git
cd gentle-dot
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` construye la interfaz y arranca el servicio local en `127.0.0.1:4317`. Abre el enlace que imprime la terminal y configura tu proveedor de modelo desde **Cuentas**. El enlace incluye una credencial de acceso: consérvalo privado. La instalación incluye el motor Gentle Shell; usar un modelo requiere tu propia cuenta o configuración de proveedor.

Esta ruta permite usar el chat web. Las ventanas flotantes, el llavero y el control nativo del equipo necesitan la aplicación de escritorio. Si ya tienes Gentle Dot en ejecución, usa esa instancia o ciérrala antes de arrancar otra en el mismo puerto; consulta [aislamiento y datos locales](docs/fork.md#datos-y-compatibilidad) para desarrollo separado.

## Instalar el escritorio

En Linux, elige el script de tu distribución desde el repositorio:

```sh
scripts/linux/setup-debian.sh   # Debian / Ubuntu
# O bien:
scripts/linux/setup-arch.sh     # Arch / Omarchy
```

Los scripts preparan dependencias, Node/pnpm y Rust, construyen la aplicación e instalan un lanzador en `~/.local/bin/gentle-dot`. Piden autorización para instalar paquetes del sistema. Conserva el checkout: esta instalación utiliza sus rutas. Los detalles de GNOME, Hyprland, bandeja y atajos están en [la guía de escritorio](apps/desktop/README.md#linux).

Para crear paquetes Linux con Docker, usa `pnpm package:linux --arch amd64` o `--arch arm64`. En un Mac Apple Silicon con Rust y las herramientas de Xcode, usa `pnpm package:mac`. Sigue [instalación, permisos y desinstalación](docs/install.md) para el paquete resultante.

El control visual añadido en Linux admite **Hyprland/Wayland y X11**, con sus herramientas instaladas. GNOME/KDE sobre Wayland no admiten ese control nativo actualmente. El acompañante flotante Capri de PC requiere **Hyprland con configuración Lua**. Son capacidades distintas: consulta [control del equipo](docs/computer-control.md) y [Capri en el escritorio](docs/capri.md#capri-sobre-el-escritorio-de-pc).

## Compilar y vincular Android

Necesitas además **JDK 21 o posterior, Android SDK 36 y Build Tools 36.0.0**. Configura `JAVA_HOME` y `ANDROID_HOME` según tu instalación.

```sh
pnpm android:apk --lint
```

El resultado es `build/android/gentle-dot-debug.apk`, acompañado de su SHA-256. Instálalo directamente en tu teléfono; con las herramientas ADB puedes usar `adb install -r build/android/gentle-dot-debug.apk`. Es una compilación de desarrollo, no una publicación de Play Store. Conserva la misma clave de firma para actualizar una instalación existente sin tener que desinstalarla.

Con Gentle Dot abierto en el PC y ambos dispositivos conectados a tu red privada Tailscale:

```sh
# Publica el servicio sólo dentro de tu red Tailscale:
tailscale serve --bg 4317
pnpm mobile:connect
```

Escanea el QR desde Android y confirma la vinculación en el PC. Si no tienes `qrencode`, `pnpm mobile:connect --show-link` permite copiar el enlace privado. El código vence en cinco minutos. Si ya usas Tailscale Serve para otro servicio, revisa su configuración antes de cambiarla. Consulta [la guía de Android](docs/android.md) y [conexión y sesiones](docs/mobile-orchestration.md) para permisos, revocación y resolución de problemas.

**El PC ejecuta el asistente y debe permanecer despierto, conectado y con Gentle Dot en marcha.** Android es su cliente: el personaje puede animarse localmente sin PC, pero conversar, controlar sesiones y recibir novedades del equipo requiere esa conexión. Este fork no añade un asistente cloud independiente ni un proveedor de notificaciones push.

## Qué añade este fork

| Área | Uso y documentación |
| --- | --- |
| Sesiones de agentes | Descubrir, inspeccionar, crear y continuar sesiones Pi/Gentle Shell mediante Herdr, Orca o terminales compatibles; [guía](docs/mobile-orchestration.md). |
| Entrega y preguntas | Estados de envío y recepción separados, `steer`/`followUp`, preguntas estructuradas y permisos dentro de la conversación; [entrega](docs/session-delivery.md), [preguntas](docs/agent-questions.md), [presentación](docs/mobile-contextual-requests.md). |
| Continuidad | Objetivos y vigilancias persistentes, historial paginado y recuperación de recuerdos; [chat y memoria](docs/continuous-assistant.md). |
| Chat y archivos | Apariencia por dispositivo, lectura sin saltos, diagramas, visor de imágenes, archivos privados y adjuntos a sesiones; [Android](docs/android.md), [adjuntos de agentes](docs/agent-attachments.md). |
| Avisos Android | Eventos en directo y recuperación de conexión, filtros por tipo y avisos dentro de la app; [comportamiento y límites](docs/mobile-notification-delivery.md). |
| Acompañante Android | Activación voluntaria sobre otras apps, conversación parcial, borradores cifrados y navegación a la sesión exacta; [guía](docs/android-companion.md). |
| Linux y cuentas | Control visual compatible, navegador dedicado, autenticación administrativa local y reutilización de la sesión existente de GitHub CLI; [control](docs/computer-control.md), [autenticación](docs/system-authentication.md), [GitHub](docs/github.md). |
| Capri opcional | Sprites locales, animaciones, colores, zonas de movimiento y personalidad independiente; [uso](docs/capri.md), [límites del tema](docs/fork.md). |
| Consumo y terminal | Lecturas de cuota Codex/Claude y ambientes reversibles para ventanas Kitty compatibles; [porcentajes](docs/usage-badges.md), [ambientes](docs/terminal-moods.md). |

El [registro completo del fork](docs/fork-changelog.md) incluye los cambios de implementación, compatibilidad y comprobación. Las sesiones ya abiertas conservan el adaptador que cargaron: actualizar la app no recarga agentes ni cambia preguntas pendientes. Instala el adaptador actual en sesiones nuevas o recárgalo cuando estén en reposo, según la guía de sesiones.

## Estado y comprobaciones

Hay pruebas unitarias, de integración, navegador y contratos nativos. Una compilación correcta no garantiza el comportamiento de todos los escritorios o teléfonos. **La validación física del acompañante Android, teclado, bloqueo de pantalla, recuperación del proceso y batería sigue pendiente** en la evidencia documentada. Android puede suspender los avisos; los envíos sin confirmación requieren revisar el historial antes de repetirlos.

Desde la raíz, las comprobaciones generales son:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Las pruebas móviles y nativas tienen requisitos adicionales: consulta [validación del fork](docs/fork.md#validación), [Linux](docs/linux-testing.md) y [Android](docs/android.md#verificación). Las cifras históricas de pruebas en las guías corresponden a sus revisiones, no certifican una compilación nueva.

Lee [SECURITY.md](SECURITY.md) para las fronteras de confianza y [higiene del repositorio](docs/repository-hygiene.md) antes de publicar cambios. Las conversaciones, cuentas, invitaciones, claves de firma y archivos del usuario pertenecen al almacenamiento local, no al repositorio.

## Autoría y licencia

Gentle Dot es un proyecto de **Gentleman Programming / Alan Buscaglia**. Este fork mantiene su [licencia MIT y aviso de copyright](LICENSE), y no implica respaldo del autor original. Gentle AI™ y Engram™ son marcas de Alan Buscaglia; consulta el [aviso de marcas upstream](https://github.com/Gentleman-Programming/gentle-ai/blob/main/TRADEMARKS.md).

Capri es la personalización de Eduardo Garza. Sus sprites y los de Rebecca son arte de fans inspirado en *Cyberpunk: Edgerunners*, generado y empaquetado localmente. La licencia del software no concede derechos sobre personajes o marcas ni representa afiliación o respaldo de sus titulares. El [aviso del tema](packages/theme-capri/NOTICE.md) y su [procedencia](packages/theme-capri/provenance/) explican esa distinción.
