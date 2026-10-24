# Usar y mantener este fork

Este repositorio conserva **Gentle Dot como aplicación base** y **Capri como personalización opcional**. El origen es [`Gentleman-Programming/gentle-dot`](https://github.com/Gentleman-Programming/gentle-dot); el fork es [`ed-gz/gentle-dot`](https://github.com/ed-gz/gentle-dot). Para instalarlo, empieza en el [README](../README.md). Para revisar qué cambió respecto de upstream, usa el [registro del fork](fork-changelog.md).

La [revisión upstream del 23 de octubre de 2026](upstream-2026-10-23.md) registra las correcciones seleccionadas, sus adaptaciones para este fork y las propuestas aplazadas, incluida la evidencia oficial del runtime Node 24.22.1.

## Elegir Gentle Dot o Capri

Una instalación nueva usa la apariencia y personalidad de Gentle Dot. Los usuarios que ya habían elegido Capri conservan su preferencia durante la migración.

| Ajuste | Alcance |
| --- | --- |
| **Tema Capri** | Sprites, escenas y colores de este dispositivo. Puede cambiarse sin conexión. |
| **Conversación → Personalidad Capri** | Nombre y tono opcionales del agente; sólo aparecen activos después de que el motor confirme el cambio. |
| Acompañante de escritorio | Ventana nativa y preferencias de ese PC; requiere Linux con Hyprland y configuración Lua. |
| **Este teléfono → Sobre otras apps** | Servicio Android optativo, con permiso del sistema y notificación persistente; requiere Android 8+. |

La apariencia y la personalidad son independientes. El tema no concede permisos, conecta cuentas, crea sesiones ni envía mensajes. Los sprites vienen incluidos: activar o animar Capri no llama a un generador de imágenes. Las guías de [Capri](capri.md) y [acompañante Android](android-companion.md) describen controles y límites.

## Dónde vive cada responsabilidad

| Ruta | Responsabilidad |
| --- | --- |
| `packages/protocol` | Mensajes compartidos y contrato neutral de presentación de temas. |
| `packages/daemon` | Motor, memoria, conectores, sesiones, entrega y autorización. |
| `packages/ui` | Conversación, ajustes, solicitudes y presentación del acompañante. |
| `packages/theme-capri` | Sprites, manifiestos de animación, escenas, colores, personalidad opcional y procedencia. |
| `apps/desktop` | Ventanas nativas, integración del sistema y aprobaciones locales. |
| `apps/mobile` | Vinculación Android, avisos, almacenamiento seguro, acompañante y conversación parcial. |

Los imports anteriores de Capri en la UI conservan adaptadores de compatibilidad. Una nueva integración debe consumir `@gentle-dot/theme-capri` y el contrato `CompanionThemeManifest`; añadir otro tema no debe requerir cambiar la autorización o la entrega de mensajes.

## Conexión y ejecución

El teléfono se vincula con el PC mediante HTTPS/WSS privado de Tailscale. El PC ejecuta el modelo, los agentes y las vigilancias. Debe estar despierto y con el servicio disponible; cerrar el móvil no detiene esos trabajos, pero apagar o suspender el PC impide que continúen.

El acompañante puede dibujarse y responder al tacto sin conexión. Esto no significa que el asistente funcione sin PC. Esta revisión no aprovisiona un servidor cloud, Cloud/Claude Bridge, migración de cuentas ni servicio de push. El [modo VPS heredado](deploy-vps.md) es una configuración aparte y no activa el control de sesiones o del escritorio del anfitrión.

## Datos y compatibilidad

Se conservan el identificador Android, el identificador Tauri, el esquema de vinculación y las claves de preferencias existentes. Cambiar el tema no borra conversaciones ni cambia la identidad de las sesiones. Para actualizar Android, conserva el certificado con el que firmaste la instalación anterior.

Por defecto, configuraciones, sesiones y estado del servicio viven en `~/.gentle-dot`; Engram puede usar `~/.engram`. El código fuente y esos datos son cosas distintas. Para probar un servicio separado sin ocupar el puerto o carpeta de la instalación habitual:

```sh
GENTLE_DOT_DATA_DIR="$HOME/.gentle-dot-dev" GENTLE_DOT_PORT=4318 pnpm dev
```

Esto separa el estado de Dot; no constituye una caja de aislamiento del sistema operativo ni separa automáticamente todos los servicios externos. Revisa [seguridad](../SECURITY.md) antes de conectar cuentas. En particular, el motor conserva su carpeta personal propia, pero puede usar la configuración existente de GitHub CLI según las reglas de [GitHub](github.md).

Las sesiones externas conservan el código de extensión que cargaron al iniciar. No recargues una sesión ocupada para activar una novedad: `/reload` puede cancelar trabajos auxiliares. Usa una sesión nueva o espera a que no haya tareas, preguntas, mensajes pendientes o monitores que deban continuar. Nunca abras el mismo archivo de sesión en dos agentes a la vez.

## Mantener y publicar

Usa `origin` para el fork y `upstream` para Gentle Dot original. Si aún no tienes ese remoto:

```sh
git remote add upstream https://github.com/Gentleman-Programming/gentle-dot.git
git fetch upstream
```

Revisa los cambios antes de integrarlos. La primera aportación de este fork importa trabajo Android/Linux desarrollado previamente; su tamaño no equivale al de una corrección pequeña para upstream. Las unidades posteriores separan tema, borradores, ventanas Android y su integración. El [registro](fork-changelog.md) conserva esa procedencia.

Publica fuentes, pruebas, sprites de producción, manifiestos y procedencia saneada. Excluye datos de ejecución, credenciales, claves de firma, invitaciones de vinculación, notas privadas, cachés y compilaciones. Este repositorio se entrega como fuente: genera APK/instaladores localmente. La política actual también excluye instaladores en releases y artifacts públicos; cambiarla requiere una decisión explícita. Sigue [la política y comprobaciones de higiene](repository-hygiene.md).

## Validación

Ejecuta las comprobaciones que correspondan a la capa modificada:

| Cambio | Comprobaciones |
| --- | --- |
| UI, protocolo o daemon | `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; añade los casos de navegador afectados. |
| Interfaz móvil | `pnpm e2e:mobile`, con las dependencias de Playwright disponibles. |
| Android nativo | `pnpm android:apk --lint`; después, en `apps/mobile/android`, `./gradlew :app:testDebugUnitTest`. |
| Escritorio | Compilación Tauri y pruebas Rust; las pruebas optativas de WebKit/Hyprland se describen en [escritorio](../apps/desktop/README.md). |
| Paquetes Linux | `pnpm package:linux:check --arch amd64` o `--arch arm64`, con Docker. |

Los comandos son instrucciones para reproducir comprobaciones; su presencia en esta guía no significa que se hayan ejecutado para cualquier revisión nueva. Las pruebas web con puentes simulados no prueban permisos Android reales. Antes de distribuir una compilación, registra por separado la prueba física de bloqueo de pantalla, teclado, rotación, reconexión, borradores y ahorro de batería. La verificación del acompañante Android en un teléfono físico sigue pendiente en el registro de esta revisión.

## Créditos

Se mantiene el aviso MIT de Gentleman Programming. Capri es la personalización de Eduardo Garza y su arte de fans no representa un producto oficial de *Cyberpunk: Edgerunners*. Consulta la [licencia](../LICENSE) y el [aviso de personajes y procedencia](../packages/theme-capri/NOTICE.md); la licencia del código no concede derechos sobre esos personajes o marcas.
