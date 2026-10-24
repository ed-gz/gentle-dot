# Gentle Dot en Android: sesiones y navegador

La APK conecta el mismo chat de Gentle Dot con el equipo mediante HTTPS privado de Tailscale. Desde **Agentes** puedes revisar sesiones, continuar trabajo, responder confirmaciones compatibles y conceder permisos temporales para una acción revisada. El equipo ejecuta los agentes; el teléfono actúa como control remoto.

## Conectar el teléfono

1. Inicia Gentle Dot en el equipo. Activa Tailscale en ambos dispositivos, dentro de la misma red privada.
2. Instala la APK generada por `pnpm android:apk`.
3. En el proyecto ejecuta `pnpm mobile:connect`. Escanea el QR desde la app y autoriza el teléfono en el diálogo de Gentle Dot del equipo. Si prefieres copiar el enlace: `pnpm mobile:connect --show-link`.
4. El código vence en cinco minutos y sólo se puede usar una vez. Genera otro cuando sea necesario.
5. Envía un mensaje de prueba y comprueba que aparecen la conversación y el estado de conexión.

La URL debe ser el origen HTTPS de Tailscale, por ejemplo `https://equipo.red.ts.net`. `tailscale serve` debe apuntar al puerto local de Gentle Dot (4317 por defecto). No se necesita Funnel ni abrir puertos públicos. El generador comprueba que esa URL llega al mismo daemon antes de emitir el QR.

Cada teléfono recibe una clave propia. La app la guarda con almacenamiento seguro nativo; el equipo conserva sólo su hash. Para ver dispositivos: `pnpm mobile:connect --list`. Para retirar acceso: `pnpm mobile:connect --revoke ID`. La revocación cierra también el chat abierto del dispositivo. **Desvincular** en la app revoca su propia clave en el equipo antes de borrarla del teléfono; si no hay conexión, conserva la clave para reintentarlo.

## Mensajes y permisos desde PC o teléfono

Puedes enviar indicaciones mientras Dot trabaja. El chat muestra **Recibido** sólo cuando el motor acepta el mensaje. Las indicaciones entran juntas antes del siguiente paso del modelo; no esperan a que termine todo el objetivo. Si Dot está generando una respuesta, cede esa generación para incorporar el mensaje. Una herramienta que ya está ejecutándose conserva su ejecución y sus permisos: la indicación se incorpora en el siguiente punto seguro. No se lanza un segundo modelo para atender el mismo chat.

Los permisos de Dot muestran **Permitir** y **Rechazar** dentro de la aplicación de escritorio, aunque haya un teléfono conectado. También puedes responderlos en **Sesiones** desde el teléfono autorizado. La primera respuesta válida resuelve la solicitud en todas las vistas; una respuesta tardía no cambia la decisión. La tarjeta conserva la vista previa completa y su vencimiento. La web sin el canal de confianza de la aplicación no obtiene autorización por mostrar esa tarjeta.

Detener una respuesta cancela también su relevo pendiente. Las vigilancias y delegaciones mantienen su estado; detener la respuesta no equivale a apagar el bot.

## Usar voz

Pulsa el micrófono, dicta y revisa el texto antes de enviarlo. La app usa el reconocimiento de Android; la disponibilidad sin conexión depende del motor y de los idiomas descargados en el teléfono. No hace falta una clave de OpenAI para este modo. El modelo Parakeet descargable de la app de escritorio no se incluye en la APK.

## Trabajar con sesiones

El panel **Agentes** prioriza las sesiones y los permisos pendientes. Los gestores se detectan en segundo plano y su diagnóstico permanece plegado; al crear una sesión puedes elegir dónde abrirla:

| Gestor | Acceso |
|---|---|
| Herdr | Descubre paneles y abre sesiones con su API local. |
| Orca | Consulta y crea terminales mediante su CLI oficial; la aplicación debe estar abierta y la carpeta de trabajo ya registrada en Orca. |
| Otros terminales | Descubre agentes que cargan el adaptador de Dot, independientemente de la ventana. La creación usa un lanzador compatible instalado. |

Las sesiones compatibles exponen conversación, estado y confirmaciones. Puedes enviar una instrucción o detener el trabajo con **Detener**. Con el adaptador actual de Dot, la identidad se comprueba con el proceso real, su fecha de arranque, el identificador de sesión y una instancia única; un proceso nuevo no hereda permisos del anterior. La compatibilidad con el adaptador anterior de HERDR Mobile conserva sus comprobaciones de proceso y sesión. Sólo puede responder cuestionarios que publiquen un canal cooperativo real; no habilita permisos temporales ni inventa respuestas para diálogos sin ese canal.

También puedes pedirlo desde el chat: “Revisa mis sesiones y continúa la de este proyecto con la siguiente tarea”. Gentle Dot dispone de herramientas para listar, inspeccionar, crear, detener y enviar instrucciones. El agente principal no tiene herramientas de aprobación ni de concesión de permisos.

Una terminal sin adaptador puede aparecer en la lista sin admitir control estructurado. No se escriben respuestas automáticas en terminales desconocidas. Las nuevas sesiones creadas por Dot incluyen el adaptador. Las sesiones con el adaptador de HERDR Mobile ya permiten inspección e instrucciones; necesitan la extensión de Dot para responder confirmaciones desde esta app.

Para una sesión existente, conserva su identificador o archivo y vuelve a abrirla desde el proyecto con `pnpm sessions:launch -- --cwd /ruta/proyecto --session <archivo-o-id>`. Para una nueva, ejecuta `pnpm sessions:launch -- --cwd /ruta/proyecto` en una terminal interactiva. El lanzador configura el adaptador y el registro privado automáticamente; Herdr y Orca se detectan por su entorno. No abras el mismo archivo de sesión simultáneamente en dos agentes. La variable `GENTLE_DOT_DATA_DIR` permite elegir otra instalación de Dot.

Para incorporar el adaptador a próximas cargas de Pi / Gentle Shell sin reabrir la conversación, puedes instalar la extensión global:

```sh
node scripts/orchestration/prepare-session-extension.mjs --install --agent-dir ~/.pi/agent
```

La próxima apertura de una sesión cargará el adaptador. `/reload` conserva la conversación, pero Gentle Shell puede cancelar trabajos y monitores de sus extensiones al recargarlas: no lo uses si hay tareas delegadas o vigilancias que deban continuar. En esta instalación el adaptador ya quedó instalado para la siguiente carga; no se recargaron ni respondieron las preguntas existentes. El guard de carga evita duplicarlo cuando el lanzador de Dot ya incluye la misma extensión.

No todos los motores tienen la misma API: esta integración controla Pi / Gentle Shell y los adaptadores compatibles. Un terminal con Bash, Codex u otro motor sin adaptador puede aparecer como no conectado; no se le envían teclas ni se aceptan sus permisos a ciegas.

## Navegador desde el teléfono

En **Agentes**, activa **Navegador de Gentle Dot** por 30 minutos, una hora u ocho horas. Después pide desde el chat que abra una página, lea su contenido o complete una tarea. Dot utiliza un perfil propio de Chromium/Chrome, conserva ese perfil entre sesiones y admite hasta ocho pestañas. Las acciones usan elementos observados en una instantánea reciente. No necesita un puerto de depuración público.

Puedes detener el navegador desde la misma tarjeta. Al detenerlo o vencer el plazo se cierran las ventanas y se cancelan las acciones pendientes. El agente no puede activar ni ampliar su propio permiso. La autorización temporal permite manejar páginas; las operaciones con consecuencias externas siguen requiriendo tus instrucciones y permisos.

Este navegador no incluye tus pestañas ni las cuentas de tu navegador personal. Si necesitas iniciar sesión, usa una ventana visible del navegador dedicado en el equipo. El control general del escritorio de la versión oficial sigue limitado a macOS; esta mejora añade navegación en Linux, sin prometer control de todas las aplicaciones.

En instalaciones con systemd, `detached` por sí solo no separa una ventana del grupo del servicio. Para conservar ventanas al reiniciar Dot puede configurarse `GENTLE_DOT_TERMINAL_ARGV` como `["/usr/bin/systemd-run","--user","--scope","--collect","--quiet","/usr/bin/kitty","--"]`. La sesión gráfica debe seguir activa.

Los controles locales de sesiones y navegador se desactivan en el modo VPS de la versión oficial, donde el agente y el servidor usan usuarios distintos. Así no se ejecuta un agente de escritorio con los permisos elevados del servidor.

## Permisos propios de Gentle Dot

Un teléfono nuevo recibe permiso para responder a los conectores de Dot sólo después de autorizar su vinculación en el diálogo nativo del equipo. Los teléfonos vinculados con una versión anterior conservan el chat; vuelve a vincularlos para habilitar esta capacidad. La clave general del chat y la clave del agente no permiten contestar estas solicitudes.

Si hay un teléfono autorizado conectado, la solicitud aparece en **Sesiones → Permisos de Gentle Dot**, con el conector, la acción y todos sus argumentos. El monitor nativo mantiene esa conexión en segundo plano y avisa del permiso. Si no hay ningún teléfono autorizado conectado, se utiliza el diálogo del equipo. Un corte temporal del teléfono conserva la solicitud hasta su vencimiento. Si empezó en el equipo, el teléfono puede recuperarla al conectar; sólo la primera respuesta decide. En Linux el diálogo original puede permanecer visible hasta cerrarlo y sus respuestas tardías se ignoran. Revocar su acceso, cancelar la operación o dejar vencer el plazo rechaza la solicitud.

Los conectores nuevos y sus ajustes se siguen iniciando desde la aplicación del equipo. Las confirmaciones concretas pueden responderse en el teléfono autorizado. La delegación de un objetivo a agentes no cambia la autorización de los conectores del equipo.

## Decisiones dentro del objetivo

Encarga el resultado a Dot desde el chat. El seguimiento conserva tu instrucción original, el objetivo y las sesiones que participan. Si un agente pide una confirmación, una opción, texto o un cuestionario compatible, Dot se despierta, inspecciona la solicitud y puede contestarla cuando la respuesta está comprendida en el encargo. No hay un modo nocturno ni formularios de horas o número de usos.

Dot decide cómo avanzar dentro del objetivo. Si falta una decisión tuya, la operación amplía el encargo o el canal no admite respuesta, lo explica y pausa ese seguimiento. Puedes aclararlo en el chat y pedir que continúe, o usar Pausar/Reanudar desde Ajustes. Cambiar de tema no cancela un objetivo guardado.

La respuesta se vincula a la solicitud que Dot acaba de leer y a la sesión exacta. Si la pregunta cambió o alguien la contestó, Dot debe inspeccionar de nuevo. Una respuesta no concede permisos generales a solicitudes futuras. Si el envío quedó sin confirmar, el seguimiento se pausa para evitar una acción duplicada.

Los botones **Permitir / Rechazar** siguen disponibles para intervenir personalmente. Las autorizaciones temporales creadas por versiones anteriores se pueden revocar en sus detalles; la nueva interfaz no ofrece crear más. Los objetivos antiguos conservan sus límites y no adquieren una delegación nueva automáticamente: un nuevo encargo o una aclaración en el chat permite guardar la instrucción humana correspondiente.

Un diálogo abierto antes de cargar el adaptador nuevo no adquiere retroactivamente un canal remoto. Si indica **Necesita el equipo**, contéstalo en su terminal y carga la extensión actual cuando el agente esté en reposo. La actualización de la APK por sí sola no puede modificar ese diálogo ya abierto.

## Avisos y continuidad

Pide a Dot un objetivo concreto, por ejemplo: “Coordina estas dos sesiones: una implementa y la otra revisa; continúa hasta completar el plan, sin ampliar el alcance”. Dot registra el objetivo y sus sesiones, sin plazo ni cuota de continuaciones predeterminados. Los resultados, preguntas y cambios de conexión despiertan al motor aunque no esté conectado el teléfono; primero inspecciona y luego encarga el siguiente paso permitido. El estado y los eventos pendientes se guardan en el equipo para recuperarlos tras un reinicio.

En **Ajustes → Trabajo en segundo plano** puedes revisar objetivo y estado, pausar, reanudar o finalizar. Continúa hasta completarlo; sólo tiene plazo o cuota si se acordaron explícitamente. Los límites de objetivos anteriores se conservan y pueden consultarse en sus detalles. Los resúmenes genéricos y las notificaciones son independientes de este objetivo: silenciar avisos no detiene un seguimiento. Cambiar de tema tampoco borra el objetivo; puedes pausarlo desde la app. El seguimiento puede responder solicitudes concretas dentro del encargo humano y de las sesiones registradas; no puede ampliarlas por su cuenta. Los envíos dudosos se pausan para evitar duplicados.


La app muestra eventos de terminación y solicitudes de atención. Los avisos en segundo plano requieren activar la monitorización nativa y conceder notificaciones. Android puede limitar servicios en segundo plano; abre de nuevo la app para recuperar el estado y los eventos. No se utilizan servicios públicos de notificaciones.

El equipo debe estar encendido, conectado y con Gentle Dot y el gestor elegido disponibles. En esta instalación, el servicio de escritorio inicia con la sesión gráfica: no garantiza acceso antes de iniciar sesión ni durante suspensión. Un corte de red no detiene el agente del equipo. La app reconecta y consulta de nuevo el estado; también recupera respuestas del chat finalizadas durante un corte de red mientras su monitor seguía activo. Una autorización vencida no se reutiliza.

## Quedarse pendiente sin gastar tokens en espera

Di una vez «Estate pendiente de mis agentes y avísame cuando terminen o necesiten algo». Dot registra una vigilancia persistente: sigue activa al cambiar de tema, cerrar el móvil o reiniciar el servicio. Para encargar trabajo, añade el objetivo y sus criterios de terminación; los seguimientos por objetivo continúan el plan, mientras una vigilancia general comunica novedades. Los eventos de sesiones ya atendidas por un objetivo no provocan otro aviso general.

En **Ajustes → Pendiente de novedades** puedes ver, pausar, reanudar o eliminar estas vigilancias. También puedes pedirlo por chat. No hay un modo nocturno ni formularios de creación. Detener una respuesta de chat descarta ese aviso; las vigilancias permanecen activas hasta pausarlas. Pausar no detiene a los agentes.

La espera usa comprobaciones ordinarias, sin llamadas al modelo. Los agentes se observan mediante el monitor local existente; el motor sólo recibe un turno cuando hay un lote nuevo. La consulta de correo se realiza aproximadamente cada dos minutos, con espera progresiva si falla. Se conservan los eventos, la referencia de lectura y la confirmación del aviso para recuperar reinicios y evitar duplicados. Durante una desconexión prolongada puede recuperarse el último resultado disponible de cada sesión; no se promete reconstruir todas las respuestas intermedias.

El adaptador de correo inicial admite **Gmail del catálogo**, con una cuenta conectada y activada en Dot. Regístralo con «Estate pendiente de mi correo». No reutiliza las cuentas de otras aplicaciones ni envía respuestas automáticamente. Otros proveedores necesitan un adaptador compatible. El primer chequeo establece una referencia sin anunciar el historial; después se leen identificadores, remitentes, asuntos y vistas previas. La vigilancia no lee cuerpos completos ni trata un correo como una orden.

Gmail MCP ofrece búsquedas recientes, no un cursor de llegada. Este adaptador consulta los últimos dos días y deduplica mensajes, hasta 200 conversaciones y 512 identificadores recientes. Un mensaje con fecha antigua recibido con retraso puede quedar fuera. Si cambia la cuenta, la respuesta del conector, se supera ese volumen o pasan más de dos días sin poder consultar, la vigilancia explica el problema y se pausa; revisa el correo y reanuda para establecer una referencia nueva. No sustituye una cola de correo con garantía de entrega. Los errores transitorios se reintentan sin generar respuestas repetidas de Dot.

El modelo sí consume tokens cuando interpreta una novedad o trabaja en un objetivo. El equipo debe permanecer despierto y con el servicio activo. No se ha verificado recepción con una cuenta de correo real en esta instalación porque todavía no hay ninguna conectada.

## Construcción y verificación

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm android:apk
```

La compilación móvil requiere JDK y Android SDK compatibles con la versión fijada de Capacitor. El script muestra los requisitos y la ruta de la APK. La APK de desarrollo sirve para instalación directa; la distribución pública necesita una firma de lanzamiento administrada por el propietario.

La implementación prueba autenticación, expiración, revocación, aislamiento entre sesiones, respuestas obsoletas y límites de las políticas. Una prueba de escritorio o de servidor no sustituye la prueba en un teléfono real de micrófono, cámara, batería y notificaciones.

La prueba opcional de integración real crea su propio servidor HERDR y un perfil temporal de Pi, sin invocar un modelo ni tocar sesiones existentes. Verifica registro del proceso real, lectura de conversación, una confirmación nativa aceptada mediante una autorización de un uso y una segunda confirmación rechazada manualmente:

```sh
GENTLE_DOT_LIVE_TEST=1 HERDR_BIN=/ruta/a/herdr GENTLE_DOT_PI_BIN=/ruta/a/pi \
  node packages/daemon/test/orchestration-live.ts
```

## Referencias técnicas

- [Requisitos de Capacitor](https://capacitorjs.com/docs/getting-started/environment-setup).
- [Reconocimiento de voz de Android](https://developer.android.com/reference/android/speech/SpeechRecognizer).
- [Protocolo y API de HERDR](https://herdr.dev/docs/socket-api/).

## Delegación por sesión e historial

`dot_workflows start` admite `mode: "session"`, exactamente una identidad pane/session y la fuente humana verificada. Esta delegación no tiene caducidad predeterminada ni se completa al terminar un trabajo: espera solicitudes hasta pausa o revocación. Sólo inspecciona y responde solicitudes verificadas; no acepta `prompt` ni `complete`. Puede coexistir con un objetivo finito, que conserva la continuidad del trabajo sin duplicar respuestas a permisos.

`inspect` acepta `before` y `limit` (1–100), con `history: {hasEarlier, before?, supported}`. El cursor está vinculado a la rama; un cursor desactualizado se rechaza. Adaptadores anteriores declaran `supported:false` y requieren recarga cuando la sesión esté en reposo.

Detener un turno de Dot no llama `pauseAll`: cada objetivo o delegación se pausa explícitamente por separado. Las aprobaciones manuales de sesiones son independientes del proveedor del modelo. Un teléfono previamente autorizado también puede responder solicitudes del navegador con un daemon local sin app nativa; los conectores conservan sus requisitos de confianza originales.
