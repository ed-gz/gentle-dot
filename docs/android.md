# Gentle Dot Android

La APK incluye la interfaz de Gentle Dot y se conecta al daemon de tu equipo por HTTPS/WSS dentro de Tailscale. El asistente y los agentes siguen ejecutándose en el equipo.

## Compilar

Requisitos: Node 24+, pnpm 11.5.0, JDK 21 o posterior, Android SDK 36 y Build Tools 36.0.0. Define `JAVA_HOME` y `ANDROID_HOME`; instala las plataformas y herramientas del SDK desde Android Studio o `sdkmanager`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @gentle-dot/mobile typecheck
pnpm android:apk --lint
```

El resultado instalable es `build/android/gentle-dot-debug.apk` y su hash está en `build/android/gentle-dot-debug.apk.sha256`. Es una APK de desarrollo firmada con la clave debug local, apta para instalación directa; no es un paquete de publicación en Play Store. Para actualizar una instalación, conserva la misma clave de firma. No guardes claves privadas de publicación en el repositorio.

El script verifica la firma y la alineación del paquete antes de copiarlo a esa ruta. El parche **0.21.3 / código 37** corrige la sincronización y confirmación del personaje Capri; conserva la ayuda de permisos incorporada en 0.21.1. La versión y su código están fijados en `apps/mobile/android/app/build.gradle`. Android permite actualizar una instalación anterior conservando sus datos cuando se mantiene la misma identidad y clave de firma. El APK se genera localmente y se mantiene como artefacto privado: no forma parte de Git ni se publica como descarga de GitHub.

La vista móvil usa navegación inferior **Dot · Sesiones · Ajustes**, sin cabecera permanente. Mantiene el chat y las sesiones abiertos al cambiar de pantalla, conservando borradores y posición de lectura. **Ajustes** reúne cuentas, perfiles, conexiones, modelo, voz, avisos y la opción de desvincular el teléfono. El icono de Android y la pantalla de inicio usan la rosa oficial.

El script también reconoce una instalación local de las herramientas en `.cache/android/java` y `.cache/android/sdk`; esta caché no se incluye en Git. La primera compilación descarga dependencias de Gradle y del SDK.

## Apariencia y archivos en el chat

Activa **Tema Capri** desde **Ajustes**. La personalidad del agente se elige por separado desde **Conversación → Personalidad Capri**. Capri elige sus formas y reacciones, y recibe visitas de Rebecca automáticamente. Flota sobre toda la app, incluso sobre los diálogos, y conserva su posición al cambiar entre Dot, Sesiones y Ajustes. No ocupa una fila del chat ni depende de la vista de conversación. Puedes arrastrarla con el dedo o el ratón; un toque abre las acciones **Hazte a un lado**, **Pausar movimiento** y **Minimizar a Capri**. Las flechas del teclado también permiten moverla cuando tiene el foco. Se aparta del compositor y se reajusta al aparecer el teclado. Su movimiento se pausa durante la interacción, al ocultar la app o si el sistema pide reducir movimiento. Este personaje web permanece dentro de Gentle Dot. Desde **Ajustes → Avisos y teléfono → Tu equipo → Sobre otras apps** puedes activar además el acompañante nativo de Android 8+, que requiere un permiso explícito y abre una conversación parcial. Despliega **Avisos y teléfono** para ver el control. Consulta [la guía de Capri](capri.md) y [el acompañante Android](android-companion.md).

Si Android muestra **«A la app se le negó el acceso»**, la versión 0.21.1 ofrece **Abrir información de la app** y **Volver al permiso**. Sigue [los pasos para revisar ajustes restringidos](android-companion.md#si-android-muestra-a-la-app-se-le-negó-el-acceso), disponibles sólo en algunos equipos. Dot no puede concederse el permiso ni saber con certeza por qué se denegó. Un icono o una ventana flotante del sistema con la rosa no demuestra que el personaje esté activo ni identifica su mecanismo. El sprite nativo aparece al salir de la app cuando el permiso y el servicio están activos.

Si elegiste Capri pero el acompañante sigue mostrando Gentle, consulta la [recuperación del tema en 0.21.3](android-companion.md#si-elegiste-capri-pero-aparece-gentle). Espera la confirmación **Capri está lista** y usa **Reintentar personaje** si aparece un error. La recuperación de apariencia no activa la personalidad del agente ni cambia el icono de Android.

Las acciones internas comparten un único indicador **Trabajando…**, que desaparece al finalizar el turno. No dejan tarjetas de pasos en la conversación. Si estás leyendo mensajes anteriores, las respuestas, permisos e imágenes nuevos conservan tu posición; **Volver al final** permite retomar el seguimiento. Enviar un mensaje propio también vuelve al final.

En **Ajustes → Apariencia del chat** puedes elegir tema oscuro, claro o del sistema; color de acento; tamaño del texto; espaciado; burbujas o lectura y fondo. La rosa oficial se conserva. Los ajustes se guardan en este teléfono y **Restaurar Gentle** recupera la apariencia original.

Pide a Dot que te comparta un archivo de tu equipo. El asistente dispone de `dot_share_file`, que publica una copia privada y devuelve un adjunto para el chat. Las imágenes compatibles muestran una vista previa; toca la imagen para ampliarla. **Guardar archivo** abre el selector de ubicación de Android; **Compartir** abre su menú de aplicaciones. Recibir un mensaje no descarga ni comparte automáticamente el archivo completo; sólo se carga la vista previa visible de imágenes de hasta 8 MiB.

Se admiten archivos de hasta 50 MiB. El equipo conserva las copias en `~/.gentle-dot/shared-files`, con una cuota de 512 MiB y 1024 archivos; no las borra automáticamente. La copia no cambia al modificar o eliminar el original. Las descargas requieren un teléfono vinculado o la credencial del propietario; el enlace solo no da acceso y revocar el teléfono interrumpe su acceso. Los enlaces de archivos comunes del disco no se convierten en descargas: Dot debe compartirlos con su herramienta.

Se rechazan rutas sensibles conocidas, enlaces simbólicos y credenciales reconocibles en texto. Este filtro no analiza el contenido de archivos comprimidos o cifrados. La app no ejecuta archivos recibidos. Android guarda las copias temporales para compartir en su caché privada, limitada a 200 MiB, y limpia las antiguas al iniciar o recibir otro archivo.

El chat presenta tablas desplazables, listas de tareas, citas e imágenes ampliables. Los bloques Mermaid se muestran como diagramas de flujo o mapas de ideas que se pueden ampliar; usan el tema del chat. Se cargan cuando son visibles. El contenido no se inserta como HTML ejecutable; diagramas demasiado grandes, con instrucciones de configuración o recursos externos conservan una descripción de texto. Para compartir archivos del disco se sigue usando el adjunto privado de Dot.

Los avisos repetidos de que no se pudieron comprobar los conectores se concentran en **Conexiones → Revisar acceso**, sin interrumpir el chat. Esto no desbloquea el llavero del equipo ni concede acceso a un conector: si el aviso menciona credenciales, desbloquea el llavero de Linux y reinicia Dot.

## Seguir el trabajo de un agente

Dentro de **Sesiones → conversación**, el **Plan de trabajo** muestra el avance y la tarea actual; **Ver tareas** abre la lista completa. **Acciones y subagentes** reúne delegaciones y comandos, plegado inicialmente. Los resultados y registros se abren por separado. La conversación conserva tus mensajes y las respuestas del agente, sin repetir las etiquetas Sistema/Agente. Leer los detalles no envía instrucciones, cambia permisos ni interrumpe el trabajo. No hay una sección de actividad reciente en el listado de agentes.

Las tareas vienen de los datos estructurados de Gentle Todo y las delegaciones de Gentle Agents; no se deducen del texto del chat. Los eventos del adaptador y la presencia vigente de Gentle Shell permiten mostrar actividad en vivo. **Del historial** y **Sin estado actual** distinguen un registro anterior de una ejecución confirmada. Si se pierde la conexión, se marca el contenido como desactualizado.

Las sesiones actuales con el adaptador de Herdr Mobile pueden recuperar el plan y las delegaciones de su archivo de sesión sin reiniciarlas. Esa lectura se limita a la sesión y rama verificadas por el adaptador. Para historiales grandes se usa una porción reciente y se indica que hay registros anteriores; no se garantiza mostrar todo el historial ni subagentes de extensiones que no publiquen información compatible. Las sesiones nuevas con el adaptador de Dot también exponen los eventos de comandos en vivo.

## Consumo de Codex y Claude

Abre **Ajustes → Consumo**. Cada cuenta destaca el porcentaje **disponible** y cuánto falta para el reinicio. Despliega la última lectura para ver el porcentaje usado y la fecha exacta. Los datos se consultan al abrir esta vista y cada minuto mientras siga visible; el botón de actualización respeta el plazo comunicado por el equipo y evita consultas repetidas durante su caché de un minuto.

La fuente principal es la sesión de Codex o Claude iniciada en el equipo (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`, o sus carpetas habituales). Si no existe ese perfil nativo y no se configuró una ruta explícita, puede utilizarse la sesión OAuth disponible en Pi. Un perfil existente vacío, vencido o rechazado no cambia silenciosamente a otra cuenta. Estas cuentas pueden ser distintas de la usada por el modelo de Dot. Los perfiles adicionales gestionados exclusivamente por Orca no se mezclan con ellas.

Las credenciales permanecen en el equipo. El teléfono recibe únicamente los datos de consumo; no se renuevan credenciales, compran créditos ni se envían mensajes al modelo para obtenerlos. Las claves API no equivalen a una suscripción. Ante una sesión vencida, se pide iniciar sesión en el equipo. Los fallos de red pueden mostrar la última lectura durante un máximo de 15 minutos, marcada como **Datos anteriores**; los datos ausentes no se representan como consumo cero.

Esta consulta utiliza las mismas rutas de uso de los proveedores que Orca, que pueden cambiar. Las respuestas desconocidas o incompletas se muestran como no disponibles. El modo VPS no consulta credenciales del equipo anfitrión.

## Conexión y voz

Sigue [la guía de conexión y orquestación](mobile-orchestration.md) para generar el QR en el equipo. La app muestra el equipo y la dirección antes de canjear la invitación. Solo admite orígenes HTTPS de Tailscale; no acepta HTTP, redirecciones ni credenciales en la URL. Los tokens se guardan mediante Android Keystore y se excluyen de respaldos y transferencias. En el navegador de desarrollo solo se conservan en memoria.

Con la aplicación de escritorio abierta, confirma **¿Permitir acceso a este teléfono?** en el equipo al vincular. Solo los teléfonos confirmados así pueden responder los permisos de las acciones de Gentle Dot. Una vinculación anterior a 0.2.0 permite conversar y gestionar sesiones; para habilitar estos permisos, desvincula y vuelve a vincular con el escritorio abierto. El QR no reemplaza esta confirmación inicial.

Cuando un teléfono autorizado está conectado, las nuevas solicitudes concretas se muestran dentro del **Chat** y en **Sesiones → Permisos de Gentle Dot**, con su vista previa completa, vencimiento y botones **Permitir / Rechazar**. Si no hay ningún teléfono autorizado conectado, Gentle Dot usa el diálogo habitual del escritorio. Si el teléfono se reconecta antes del vencimiento, recupera la solicitud pendiente. Gana una sola respuesta; las respuestas tardías no repiten la operación. Una respuesta móvil confirmada cierra el diálogo Linux correspondiente en el escritorio actualizado; las respuestas tardías se ignoran. Revocar el teléfono o cancelar la operación invalida la solicitud.

**Agentes** detecta las sesiones activas de Herdr, Orca y terminales compatibles en segundo plano. Toca una sesión para abrir su conversación y continuarla; el botón Atrás vuelve primero al listado. Los proveedores quedan en un diagnóstico cerrado, sin obligarte a configurarlos. **Navegación web → Duración del permiso** sólo indica cuánto tiempo autorizas a Dot a controlar su navegador; no limita el chat ni las sesiones de agentes.

El escáner usa el modelo QR incluido en la APK. No requiere descargar el módulo de escaneo de Google Play. También puedes pegar el enlace completo del QR o abrir un enlace `gentledot://pair`.

**Desvincular** retira el acceso del teléfono en el equipo antes de borrar la credencial local. Si no hay red o el equipo no confirma la revocación, la app conserva la conexión para reintentar. Para cambiar de equipo, desvincula primero el anterior. También puedes revocar teléfonos desde el equipo según la guía de conexión.

Dot y las sesiones de agentes con permiso para recibir mensajes comparten el mismo compositor de iconos. El clip sólo aparece cuando la sesión admite adjuntos; el dictado sigue disponible en sesiones de sólo texto. En agentes, el dictado es sólo entrada: no envía automáticamente ni lee respuestas de Dot. Cambiar de sesión, equipo o pantalla, desconectar o cerrar la vista descarta los resultados de voz pendientes; abrir el diálogo de voz de Android no se considera un cambio de pantalla.

El botón de dictado abre el reconocimiento de voz de Android y devuelve una transcripción editable. El usuario debe tocar Enviar. La disponibilidad, el idioma, la conexión a Internet y el procesamiento local o remoto dependen del servicio de reconocimiento instalado en el teléfono; esta versión no incluye el modelo Parakeet del escritorio. Si no hay reconocimiento instalado, la app informa el motivo y permite escribir.

## Continuar un objetivo sin otro mensaje

Cuando pides a Dot que coordine agentes hasta terminar un plan, debe registrar un **Seguimiento de Dot** con el objetivo y las sesiones concretas antes de enviar el trabajo inicial. Al terminar un agente, Dot vuelve a inspeccionar los resultados y puede encargar el siguiente paso autorizado. Funciona desde el equipo aunque cierres la app móvil y conserva el seguimiento y los resultados pendientes tras reiniciar Dot.

Puedes consultar el objetivo y estado en **Ajustes → Trabajo en segundo plano**, pausarlo, reanudarlo o finalizarlo. También puedes pedirle que lo reanude desde el chat. Un objetivo nuevo continúa hasta completarse, sin plazo ni cuota predeterminados; sólo se fijan si los pides. Los objetivos anteriores conservan sus límites, visibles en sus detalles. Pausar no detiene una tarea que el agente ya recibió; utiliza **Detener tarea** dentro de esa conversación para hacerlo. Detener la respuesta de Dot sólo interrumpe ese turno; los objetivos y delegaciones siguen activos. Pausa el seguimiento específico cuando quieras detener su continuidad.

El seguimiento se despierta por resultados, preguntas y cambios de conexión. Puede inspeccionar, continuar y responder solicitudes concretas de las sesiones registradas cuando estén comprendidas en tu instrucción original. No hay «Permiso nocturno» ni formulario de horas/usos. Si la petición exige una decisión fuera del encargo o la integración no admite respuesta, Dot te lo comunica. Si un envío queda sin confirmar, se pausa para evitar duplicarlo; los fallos de una continuación tienen un máximo de tres intentos. Las políticas anteriores siguen siendo revocables desde sus detalles.

Los avisos del teléfono y **Resúmenes en Dot** son preferencias independientes. El resumen genérico sólo propone pasos; un seguimiento explícito sí permite continuar el trabajo acordado. Las sesiones seguidas no generan además otro turno de resumen. Cambiar de tema en el chat no borra el objetivo guardado: dile a Dot que lo pause o usa su control si deseas detenerlo. Los seguimientos antiguos se conservan, pero no reciben permisos nuevos automáticamente. Una nueva instrucción en el chat permite registrar el encargo que habilita sus decisiones delegadas.

El equipo debe estar despierto y Dot debe permanecer ejecutándose. La aplicación no controla el equipo suspendido ni sigue trabajando después de cerrar el servicio de escritorio. Este cambio recupera objetivos tras un reinicio y mejora la recuperación del motor; no mantiene encendido el hardware.

## Avisos con la pantalla apagada

Abre los ajustes de alertas del teléfono, activa los avisos en segundo plano y concede el permiso de notificaciones. Un servicio nativo entrega eventos mediante la suscripción WSS de Gentle Dot y conserva una consulta cada 10 segundos para recuperar cambios. Cuando falta la red, aplica reintentos de hasta 60 segundos. La notificación permanente permite detener los avisos.

**Qué avisos recibir** permite elegir **Dot y agentes**, **Sólo Gentle Dot** o **Sólo agentes**. La preferencia se conserva en el teléfono. Las solicitudes reales de permiso siguen avisando mientras el monitor esté activo, incluso si silencias la actividad de los agentes. Para apagar todos los avisos de fondo, desactiva **Avisos en el teléfono**.

**Resúmenes en Dot** es una opción independiente, desactivada inicialmente y guardada en el equipo. Al activarla, Dot lee el último resultado de una sesión compatible que acaba de quedar disponible, lo resume en el chat y propone uno o dos siguientes pasos. Usa el modelo de Dot y puede consumir su cuota. Para recibir sólo ese resultado elaborado, elige **Sólo Gentle Dot** y activa **Resúmenes en Dot**. Puedes seguir abriendo **Agentes** para responder directamente a una sesión.

Dot espera si está ocupado o hay un mensaje tuyo pendiente. No reproduce finalizaciones anteriores a la activación; los informes pendientes no sobreviven al reinicio del servicio. Apagar la opción vacía la cola, aunque un resumen ya iniciado puede terminar. El turno automático no puede usar herramientas ni aprobar permisos. Una sesión en reposo no certifica éxito: el resumen atribuye lo dicho al agente y señala errores, cancelaciones o fallos al consultar el resultado. Sólo se pueden resumir sesiones que permiten leer su conversación. Si la sesión cambió o ya no existe, se descarta ese evento.

El servicio avisa de preguntas pendientes, respuestas terminadas, solicitudes de permiso y cambios de estado de agentes. Una sesión que deja de trabajar produce un aviso para revisar el resultado; no implica que la tarea haya pasado sus pruebas. Al tocar un aviso se abre la app: nunca se acepta un permiso desde una notificación.

Si la conexión se corta mientras el servicio sigue activo, al reconectar compara el historial del chat activo y avisa cuando hay respuestas nuevas. La primera activación establece una referencia y no reproduce todos los avisos antiguos. Esta referencia vive en memoria: después de que Android cierre el proceso, abre la conversación para revisar lo ocurrido. El inicio de avisos solo se confirma cuando Android ha iniciado el servicio; las respuestas tardías de una conexión detenida se descartan al cambiar de conexión.

Android puede detener aplicaciones por ahorro de batería, cierre forzado, reinicio o restricciones del fabricante. Después de reiniciar el teléfono o forzar el cierre, abre la app y comprueba los avisos. La preferencia cifrada permite recuperarlos cuando Android lo admite; si los desactivaste expresamente, debes activarlos de nuevo. Consulta [la recuperación del monitor](mobile-notification-delivery.md). El equipo y Tailscale deben permanecer encendidos y conectados. El servicio no usa Firebase ni un servidor de notificaciones externo.

## Verificación

Las pruebas de vinculación validan orígenes, invitaciones, caducidad, fallos de almacenamiento, revocación y respuestas inválidas. Las pruebas Android verifican que el servicio nativo rechaza URLs fuera de Tailscale y que la recuperación del historial evita avisos históricos y duplicados en la misma conexión. El chequeo Android Lint revisa los permisos y las APIs nativas.

```sh
pnpm exec vitest run apps/mobile/test/pairing.test.ts
pnpm e2e:mobile
cd apps/mobile/android
./gradlew :app:testDebugUnitTest :app:lintDebug
```

Antes de depender de los avisos durante una noche completa, verifica en el teléfono elegido: escanear QR, dictar y revisar el texto, responder un permiso explícito, recibir un aviso con pantalla apagada, cortar/restablecer Tailscale y revocar el teléfono desde el equipo. La compilación no sustituye esa validación de cámara, micrófono y gestión de batería en el dispositivo real.

## Delegar permisos de una sesión

Puedes decir: «En esta sesión, aprueba las solicitudes del plan que ya revisé hasta que te diga que pares». Dot registra una delegación persistente para esa sesión exacta y guarda tu instrucción original. No expira cuando termina una tarea ni inicia trabajo nuevo por sí sola. Una solicitud real lo despierta; mientras espera, no necesita un turno del modelo. Puedes consultar o revocar la delegación en **Ajustes → Trabajo en segundo plano**.

El historial nuevo permite **Cargar mensajes anteriores** y conserva la posición de lectura. Las sesiones con el adaptador anterior necesitan `/reload` en su terminal cuando estén en reposo; la app indica cuando no admiten recuperar más historial. No se interrumpen sesiones para actualizarlas.

## Navegador, capturas y autenticación

Dot puede solicitar acceso al navegador y recibir tu decisión desde Sesiones. Por defecto dura hasta que lo desconectes o el navegador cierre; una duración sigue siendo opcional. Cuando necesitas orientar a Dot, puede compartir una captura privada directamente en el chat. Los campos editables se ocultan en la captura.

El navegador dedicado usa su propio perfil Chromium. Para utilizar una ventana, cuenta o espacio ya abierto en Zen u otro navegador personal, Dot usa el control visual del escritorio compatible. Son accesos separados: el navegador dedicado no hereda la sesión personal. Consulta los requisitos de macOS, Hyprland y X11 en [Control del escritorio](computer-control.md).

La instalación de Chromium utiliza el diálogo de autenticación de Linux, sin pasar contraseñas por el modelo, chat o servidor. El auxiliar de escritorio debe estar instalado; **la APK sola no lo instala**. La contraseña se introduce en la computadora, no desde el teléfono. Consulta [Autenticación del equipo](system-authentication.md).

El modo Capri y sus opciones están documentados en [Capri en Gentle Dot](capri.md).
