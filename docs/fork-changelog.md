# Cambios propios del fork

Este registro explica las áreas incorporadas sobre la base upstream **`8cb20ee`**, incluidos los cambios de seguridad de publicación del **23 de octubre de 2026**. No es el changelog de Gentleman Programming: el asistente Gentle Dot, su identidad, el motor, las cuentas, los conectores, la memoria y la aplicación de escritorio ya existían en la base. Aquí se describen las ampliaciones y correcciones del fork, incluidos los trabajos locales importados en su primer commit.

El primer commit reúne un desarrollo previo extenso. Las secciones siguientes agrupan sus cambios por comportamiento y enlazan las guías o fuentes para inspeccionarlos. Los resultados históricos de pruebas pertenecen a su revisión; este documento no afirma que una suite nueva, una instalación ajena o un teléfono físico hayan sido comprobados.

## Historial de las unidades del fork

| Commit | Aportación |
| --- | --- |
| `d3a351e` | Importa el desarrollo local de Android, orquestación, continuidad, interfaz, control Linux y acompañante de escritorio, con pruebas y documentación. Es la base amplia de las áreas descritas abajo. |
| `916d1be` | Extrae recursos, escenas y personalidad a `packages/theme-capri`; mantiene Gentle Dot por defecto, migra preferencias y separa apariencia local de personalidad confirmada. |
| `9228214` | Añade borradores Android cifrados con revisiones compartidas para evitar que una ventana antigua sobrescriba otra o recupere texto ya enviado. |
| `ee10ca2` | Incorpora la ventana Android transparente, el renderizador nativo, arrastre/fijación, ocultación al bloquear y animación de reposo acotada. |
| `ab5f8f7` | Integra recuperación de borradores, enlaces a la identidad exacta de una sesión y suspensión/reconexión del chat al ocultar una ventana Android. |
| `23fc815` | Conecta controles optativos, servicio, actividad parcial y notificaciones; empaqueta Android **0.21.0 / código 34** sin duplicar atlas. |
| `ffc69b4` | Documenta límites del fork y del tema; añade exclusiones de datos privados y artefactos generados. |
| `8a37c84` | Permite localizar la configuración de GitHub CLI del escritorio desde el motor con carpeta personal aislada, respetando configuración explícita y límites VPS. |
| `488c3d8` | Rechaza datos privados, instaladores y binarios renombrados en el índice y el historial; permite recursos gráficos y el Gradle wrapper de checksum verificado. |
| `55a32d8` | Añade escaneo de secretos, cobertura de fusiones, hook anterior al push, workflow de GitHub y política de seguridad. |

La actualización documental que contiene este registro reorganiza el onboarding, corrige descripciones anteriores y enlaza las reglas de seguridad e higiene. No cambia por sí misma el comportamiento del producto.

## 1. Android conectado al equipo

Se incorpora `apps/mobile`, una aplicación Capacitor con proyecto Android nativo y scripts de compilación/vinculación. Comparte el chat del PC mediante HTTPS/WSS privado de Tailscale; el QR usa una invitación de un solo uso con caducidad. Los teléfonos tienen credenciales individuales, almacenamiento seguro y revocación. El escritorio debe confirmar la autorización adicional para responder sus permisos.

La navegación móvil conserva Dot, Sesiones y Ajustes, con dictado Android que devuelve texto editable. El usuario envía explícitamente las indicaciones de una sesión. La aplicación móvil no ejecuta el motor ni incluye el reconocimiento Parakeet del escritorio. [Android](android.md) · [Vinculación y sesiones](mobile-orchestration.md).

## 2. Descubrimiento, control y actividad de sesiones

El orquestador encuentra sesiones Pi/Gentle Shell conectadas mediante Herdr, Orca o terminales con adaptador. Permite inspeccionar conversación, crear una sesión compatible, enviar trabajo y detener una tarea sin cerrar la terminal. El lanzador y el instalador de la extensión preparan el registro privado. El control comprueba proceso, sesión e instancia; un panel o PID reutilizado no basta para recuperar la autoridad anterior.

La conversación muestra planes y tareas de Gentle Todo, delegaciones de Gentle Agents y actividad de comandos publicada por los adaptadores. Se distinguen actividad vigente, registros históricos y estado desactualizado. La lectura paginada conserva la rama de la sesión. Los motores sin canal cooperativo aparecen con las capacidades que realmente tienen. [Orquestación](mobile-orchestration.md) · [Implementación](../packages/daemon/src/orchestration/).

## 3. Envío de mensajes y borradores

Los envíos distinguen petición en curso, aceptación por la conexión, cola, recepción observada por la sesión y resultado sin confirmación. Los adaptadores actuales admiten `steer` y `followUp`; conservan una identidad de entrega para deduplicar reintentos explícitos mientras viven. El sondeo de la conversación abierta se adapta a su actividad y se pausa cuando queda oculta. No hay una cola persistente sin conexión ni garantía de entrega exactamente una vez entre reinicios.

Dot también puede incorporar indicaciones nuevas durante su trabajo en el siguiente punto seguro, sin abrir un segundo turno paralelo del modelo. Los cambios posteriores añaden borradores nativos por dispositivo/conversación, cifrados mediante Android Keystore y protegidos por revisiones entre ventanas. Rechazar un envío conserva el texto; los adjuntos guardados sólo en memoria no sobreviven a la muerte del proceso. Al regresar de segundo plano se consulta el historial sin reenviar mensajes. [Entrega](session-delivery.md) · [Acompañante Android](android-companion.md).

## 4. Preguntas, permisos y revisión RDD

El adaptador transmite confirmaciones, selección, texto, editor y formularios compatibles de Gentle Pi. Se conserva el contenido y valor original; seleccionar una opción no la envía automáticamente. La primera respuesta válida resuelve la solicitud. La identidad, vencimiento, desconexión, cancelación y compatibilidad se verifican antes de responder.

La UI permite presentar solicitudes dentro de su conversación o en una ventana única con controles reales. Cerrar la ventana no responde. Los permisos de Dot pueden resolverse desde su aplicación de escritorio o un teléfono previamente autorizado; una notificación nunca acepta por sí sola.

La revisión RDD usa un puente cooperativo ligado al proveedor y sus archivos verificados. La versión empaquetada conserva las dos decisiones del candidato; el puente adicional para una versión verificada de Gentle Shell puede ofrecer su tercera decisión explícita de permiso de sesión y repositorio. No se deduce una aprobación de texto de terminal ni se transforma cualquier diálogo personalizado en respondible. El parche fijado de `gentle-pi` se aplica también al preparar el runtime distribuible. [Preguntas](agent-questions.md) · [Presentación](mobile-contextual-requests.md) · [RDD](rdd-consent.md).

## 5. Objetivos, delegaciones y vigilancias

Se añaden seguimientos que guardan objetivo, instrucción humana, sesiones y eventos pendientes. Los resultados y preguntas despiertan una continuación dentro del encargo. Las delegaciones de una sesión conservan su propio estado hasta pausa o revocación. Cambiar de tema o detener una respuesta de Dot no cancela esos seguimientos.

Las vigilancias comunican novedades sin hacer llamadas al modelo mientras esperan. El adaptador inicial de correo usa Gmail conectado en Dot, con referencia inicial, deduplicación y límites de recuperación; no envía respuestas. Los resúmenes opcionales de finalización son distintos de encargar trabajo y no conceden herramientas o permisos. Las acciones ambiguas se pausan y no se repiten automáticamente.

Las confirmaciones operativas reconocidas pueden usar una regla local cuando existe una instrucción humana completa que las delega para esa sesión. Las condiciones o decisiones personales siguen necesitando revisión del alcance. [Continuidad y permisos](continuous-assistant.md) · [Vigilancias y objetivos](mobile-orchestration.md#quedarse-pendiente-sin-gastar-tokens-en-espera).

## 6. Historial, memoria y concurrencia

Se añade búsqueda limitada del historial propio con `dot_history`, índices de posiciones para lectura por páginas y renovación de sesiones largas con contexto de continuidad. Historial original, resumen, memoria Engram y estado de objetivos permanecen separados. Dot usa su proyecto de memoria predeterminado sin heredar accidentalmente el de otra terminal; puede recuperar recuerdos de otros proyectos conservando su origen.

La UI monta bloques de mensajes y evita reprocesar Markdown histórico con cada fragmento nuevo. Renovar la caché se difiere mientras la persona lee, selecciona texto o usa un visor. Las lecturas de sesiones independientes pueden avanzar sin bloquearse entre sí; las modificaciones de una misma sesión y las acciones de un navegador mantienen su orden. El proxy MCP separa cancelaciones de llamadas concurrentes, y los cambios de autorización de cuentas invalidan referencias antiguas. [Chat continuo](continuous-assistant.md) · [Proxy](../packages/daemon/src/mcp-proxy.ts).

## 7. Chat, voz, archivos e imágenes

La interfaz añade apariencia local, tamaños y espaciado, conservación de la posición de lectura y un indicador de trabajo compartido. Se amplía Markdown con tablas desplazables, listas de tareas, diagramas Mermaid limitados y un visor de imágenes con zoom. El ajuste del clip corrige su desbordamiento del compositor móvil; no demuestra que se haya reproducido todo solapamiento de texto reportado.

`dot_share_file` entrega copias privadas autenticadas de archivos del PC, con límites, cuotas y filtros de rutas. Android ofrece guardar y compartir explícitamente. `dot_share_screenshot` adjunta la captura válida del encargo actual cuando se solicita; las capturas internas de orientación no se publican automáticamente.

Los adjuntos a agentes transfieren bytes a la sesión exacta y revalidan capacidad, propietario y respuesta del adaptador. Una imagen requiere soporte del modelo; un archivo de audio adjunto no equivale a transcripción. El dictado de sesiones sólo prepara texto y no envía ni reproduce voz de Dot automáticamente. [Android](android.md) · [Adjuntos](agent-attachments.md) · [Clip](composer-attachments.md) · [Capturas](computer-control.md#recibir-una-captura-en-el-chat).

## 8. Notificaciones y recuperación Android

El monitor nativo combina eventos WebSocket con consultas de recuperación, deduplica avisos y mantiene filtros por tipo. La app visible puede presentar banners; en segundo plano se usan notificaciones del sistema. Las solicitudes de permiso se recuperan con su identidad completa y se retiran al resolverse.

La preferencia y credenciales del monitor se guardan cifradas para una recreación permitida por Android. Desactivarlo o desvincular elimina su estado. No molestar, canales y ahorro de batería siguen bajo control de Android. Una muerte completa del proceso puede perder avisos del intervalo sin conexión; no se garantiza recepción tras una detención forzada. [Entrega y límites](mobile-notification-delivery.md).

## 9. Control de Linux, navegador y autenticación

El control visual de escritorio se amplía a Hyprland/Wayland y X11, con herramientas y permisos concretos, listado/activación de ventanas y lectura limitada de accesibilidad cuando existe AT-SPI. GNOME/KDE sobre Wayland se declaran no compatibles. Las capturas, foco, aplicaciones protegidas y autorizaciones se verifican en la capa nativa.

El navegador dedicado utiliza su propio perfil y pestañas con permiso revocable. Se añade un auxiliar Linux de operación fija para instalar Chromium mediante polkit; la contraseña se introduce en el equipo, nunca en el chat o teléfono. El auxiliar no acepta comandos arbitrarios. [Control](computer-control.md) · [Autenticación](system-authentication.md).

## 10. Tema Capri, sprites y personalidad

Capri aporta atlas PNG transparentes, recortes y tiempos medidos, escenas y colores locales. Las animaciones responden al estado de la aplicación; no detectan emociones ni hacen llamadas al modelo para dibujarse. Se incorporan visitas de Rebecca, acciones y gestos, fijación sin congelar la expresión, zonas permitidas y adaptación a teclado, orientación y movimiento reducido.

La extracción a `packages/theme-capri` separa esa personalización del asistente. La apariencia se elige por dispositivo y la personalidad requiere confirmación del motor. Se mantienen las preferencias existentes y los imports de compatibilidad; Gentle Dot queda como valor inicial. El paquete conserva procedencia saneada y un aviso de arte de fans. [Capri](capri.md) · [Paquete](../packages/theme-capri/README.md) · [Aviso](../packages/theme-capri/NOTICE.md).

## 11. Acompañante nativo y contexto en PC

El acompañante Linux usa ventanas transparentes con zonas por monitor, arrastre, menú, fijación y acceso al chat cuando el personaje está oculto. En Hyprland con configuración Lua, las reglas temporales se limitan a sus ventanas y evitan el fondo de vidrio. El contrato de distribución exige recursos embebidos para no intentar abrir Vite en una instalación de producción.

MPRIS informa reproducción musical. El puente opcional de Quickshell entrega avisos a Capri conservando el historial del sistema; sólo omite el popup habitual tras confirmarse el dibujo, y recupera la ruta normal si falla. Las burbujas atribuyen mensajes externos y los gestos de archivo se limitan a eventos reconocidos.

Los adaptadores de editor aportan actividad y geometría numérica sin leer borradores. Un cliente Herdr opcional y reproducible añade geometría del panel. Sólo se usan datos vigentes y verificados para colocar el personaje; no se modifica ni recarga una sesión existente automáticamente. [Escritorio Capri](capri.md#capri-sobre-el-escritorio-de-pc) · [Cliente Herdr opcional](../scripts/linux/herdr-companion/README.md).

## 12. Acompañante nativo y chat parcial Android

Android 0.21.0 añade **Sobre otras apps**, activado expresamente y con permiso del sistema. Un renderizador nativo dibuja los atlas ya empaquetados sin mantener un segundo WebView de animación. El personaje admite arrastre, fijación y acciones accesibles; tocarlo abre una conversación parcial. La app principal y esa conversación ocultan sprites duplicados.

Las ventanas se retiran en bloqueo de pantalla. El reposo limita el redibujado y respeta batería y accesibilidad. Los avisos usan la entrega existente y conservan respaldo en Android si el personaje no confirma el dibujo. Al abrir una alerta de agente se verifica su sesión actual; no se selecciona un panel reciclado. [Controles, borradores y límites físicos](android-companion.md).

## 13. Consumo, ambientes de terminal y GitHub

Las lecturas de consumo Codex/Claude usan las sesiones del equipo y entregan al cliente únicamente datos de cuota. La vista detallada destaca lo disponible; los indicadores compactos muestran porcentaje usado y ventana, con preferencias locales y marcas de datos anteriores. Los valores ausentes no se inventan como cero. No se compran créditos ni se renuevan credenciales para medirlos. [Indicadores](usage-badges.md).

Los ambientes Hacker, Afterlife y Atardecer modifican una ventana Kitty verificada y permiten restaurar su paleta original. Compartir ventana exige reconocer ese alcance; otros terminales o ventanas sin canal compatible informan la limitación. [Ambientes](terminal-moods.md).

La corrección de GitHub conserva la carpeta personal aislada del motor y, en escritorio, le permite localizar la configuración previa de `gh` mediante `GH_CONFIG_DIR`. Respeta una ruta explícita y una cuenta privada ya configurada; no copia tokens ni comparte automáticamente la cuenta del anfitrión en VPS. La identidad del asistente exige comprobar el resultado real antes de afirmar que falta una cuenta o que se publicó un issue. [GitHub CLI](github.md).

## 14. Construcción, pruebas y publicación

Se incorporan el proyecto Gradle, scripts Android, fixtures de navegador, pruebas JVM, pruebas de UI/daemon y verificaciones nativas optativas. La compilación Android comprueba firma y alineación antes de copiar el APK local. Los runtimes incluyen el paquete de tema y el parche fijado de revisión; la distribución de escritorio comprueba que su UI esté embebida. Las exclusiones de Git/Docker separan fuente, arte de producción y datos locales.

Los commits registran comprobaciones concretas de TypeScript, UI, runtime, Android, navegador y Linux según el área. La evidencia histórica no sustituye una ejecución nueva. El comportamiento físico Android —overlay, teclado, bloqueo, recuperación del proceso y batería— sigue pendiente de comprobar en un teléfono. No hay aquí una garantía de recepción continua, un despliegue cloud nuevo ni un APK publicado en el repositorio. [Validación](fork.md#validación) · [Seguridad](../SECURITY.md) · [Higiene](repository-hygiene.md).

## 15. Seguridad de publicación y documentación reutilizable

El fork se entrega como fuente, sin instaladores en Git, releases o artifacts públicos. Las exclusiones locales se complementan con un guard que inspecciona los bytes preparados para commit y todas las versiones alcanzables: borrar o renombrar una APK después de añadirla no la oculta de esa comprobación. Los sprites siguen incluidos como recursos fuente. El único JAR permitido es el Gradle wrapper en su ruta exacta y con el checksum oficial verificado.

Gitleaks usa reglas predeterminadas, ignora supresiones inline y revisa también cambios introducidos al resolver merges. Dos fingerprints exactos corresponden a una misma prueba ficticia heredada; no se excluyen carpetas o reglas enteras. El hook opcional detiene el push antes de enviarlo, mientras GitHub vuelve a revisar lo recibido con permisos de lectura y herramientas fijadas. La auditoría inicial y sus límites se documentan en [higiene](repository-hygiene.md#auditoría-inicial-de-esta-política).

Se reorganiza el README para instalar, compilar y vincular una instalación propia, se corrigen guías desactualizadas de Android/Linux/RDD y se separan las decisiones de apariencia, personalidad y permisos. No se incluyen las credenciales, red privada, conversaciones ni compilaciones locales del mantenedor. [Política de seguridad y canal privado](../SECURITY.md).
