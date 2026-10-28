# Capri iOS: autonomía local y colaboración con Gentle Dot

Capri es una asistente personal de TI con el personaje 2D de PC y una conversación continua entre Apple en el iPhone y Pi/Gentle Dot en la laptop. **El candidato actual incorpora herramientas, dictado/OCR, credenciales, conexiones, trabajos durables y archivo de conversación; todavía no está aceptado en el iPhone.** Código, fixtures, compilación nativa e instalación son evidencias diferentes.

Corte: **28 de octubre de 2026, America/Monterrey**. Continuar exclusivamente en `/home/egarza/gentle-dot-capri`, rama `fix/android-capri-motion-mobile`. El origin sigue siendo `https://github.com/ed-gz/gentle-dot.git`; el checkout viejo no es una base alternativa. Android/T47 permanece abandonado y el servicio desktop no se ha desplegado ni reiniciado como efecto de esta entrega.

## Estado de aceptación actual

**La entrega ccedf29 fue instalada y rechazada por el usuario.** CI 40638610963 sí compiló y verificó la IPA integrada, pero el diseño, el primer arranque sin el arte y la funcionalidad observada no cumplieron. El retrabajo actual se mide contra esa experiencia real; no se convierte un conteo de tests en porcentaje de calidad aceptada. Evidencia y hash exactos en L26 del registro.

La IPA personal 0c20f36 ya incluye el PNG original dentro del paquete, construido en el CI privado 40721079081; la fuente pública no contiene el arte. La geometría de movimiento, el compositor, la lectura durante actividad, las revisiones y el contexto local ya tienen correcciones implementadas y pruebas de navegador. El backend de trabajos/minutas se activó sin reiniciar desktop: WSS real confirmó transferencia, reconexión, deduplicación y minutas sintéticas con seis rangos SRT/citas específicas, preservando historial y sesiones. L29–L31 conservan la evidencia; falta el recorrido desde iPhone y audio real. [Empaquetado personal](ios-personal-art.md).

**Candidato más reciente: 2162110**, construido en el CI privado [40778422916](https://github.com/ed-gz/capri-ios-personal/actions/runs/40778422916) con dos extensiones. Conserva el diario de respuestas y añade historial de Herdr por rama, avisos locales opcionales y actividad de pantalla bloqueada para el turno local, con miniatura estática del arte personal y estado obsoleto tras 90 s sin señal. La actividad no inicia ni mantiene tareas y no muestra texto privado. Para la laptop el protocolo actual no confirma qué solicitud corresponde al estado global, así que no se atribuye un turno de laptop en el widget. 109/109 pruebas Chromium, 281/281 Node locales, 49 pruebas compartidas de sesiones y CI nativo PASS; los fixtures no prueban ActivityKit ni inferencia real. App, Share, widget, entitlements y PNG exacto verificados en la IPA. Ruta, hash y alternativa estándar en la [guía SideStore](ios-sidestore.md). Firma de dos extensiones, pantalla bloqueada, avisos, inferencia y aceptación en el iPhone siguen pendientes.

## Qué está construido y qué se ha probado

| Entrega | Evidencia | Lo que no demuestra |
| --- | --- | --- |
| Fase 1, run 40600744611 | Handoff del iPhone 17e, iOS 27.2 informado por el usuario, SideStore, enlace daemon y confirmación «se mueve»; L7 se conserva | No demuestra las funciones nuevas |
| IPA anterior, código 1ff5d38, run 40627109957 | Xcode 26.3 / SDK 26.2, Swift/Rust y empaquetado correctos; IPA unsigned comprobada y publicada como capri-phase2-1ff5d38.ipa; detalle/hash en L18 | No fue instalada en esta continuación; no contiene las capacidades posteriores |
| Candidato conversacional, base 4766e38 | Corte automatizado de 156/156 Node y 42/42 navegador en 40.6 s; fixtures de Apple/host/cuentas. TypeScript pasa. Evidencia local en .cache/capri-phase2-qa/browser-current.log | No es inferencia, OAuth, Speech/Vision ni SideStore reales; esos conteos preceden a las últimas correcciones de recuperación y revocación |
| Build nativo anterior, run 40632577152 | Falló en Voice.swift: el SDK no ofrece el preset offlineTranscription. Se sustituyó por el inicializador explícito con audioTimeRange | Se conserva el fallo y su corrección; no produjo una IPA nueva |
| CI completo, run 40634400355 / SHA 60827d9 | PASS de preflight, Swift/Rust, app, Share Extension y empaquetado; IPA de 2 254 373 bytes comprobada localmente, evidencia en L23 | No está instalada y precede a los arreglos finales de recuperación y a la exportación nativa; se conserva como evidencia de compilación, no como entrega recomendada |
| Candidato 7e01cbe | 170/170 Node y 48/48 navegador, TypeScript, build de producción y Cargo offline pasan; incluye recuperación, migración y exportación nativa a Archivos | El selector UIKit nuevo requiere su siguiente CI y prueba en iPhone; fixtures no validan cuentas o inferencia reales |

El [registro de trabajo](../odd/tasks/capri-ios.md) conserva resultados posteriores y el SHA exacto de cada entrega; sus logs históricos no se reinterpretan como validación del candidato actual. La [guía SideStore](ios-sidestore.md) describe la instalación. La entrega ccedf29 posterior está registrada en L26; no es una entrega aceptada y no contiene el retrabajo actual.

La interfaz es conversación primero: Capri reacciona a actividad real, el composer recibe texto, voz y adjuntos, y las preguntas, revisiones, herramientas y resultados aparecen en el mismo hilo. Sesiones abre las conversaciones y el trabajo de Herdr directamente mediante el panel compartido de PC/Android; Archivo y Ajustes son secundarios. Se reutilizaron contratos de Composer/MessageList/AskCard/AgentWorkflow y del supervisor de Pi, sin traer servicios Android ni sustituir el rig actual.

El retrabajo posterior a 0c20f36 conserva los 100 mensajes entregados por el host principal y abre el historial paginado de cada sesión Herdr con su compositor. La verificación de sólo lectura abrió cinco sesiones reales sin enviar instrucciones. El rig recorre espacios libres del panel mediante teleport/descanso de PC; el saludo conserva actividad en curso. La recuperación del historial precede al primer frame GPU y las mediciones de posición se agrupan por frame. L33–L35 distinguen esa evidencia de la aceptación pendiente en iPhone.

La IPA 4c4401b incluye adjuntos de sesión mediante upload nativo desde archivo, validación de bytes/recibos y cancelación al cambiar de destino. Los borradores conservan los archivos en IndexedDB por host/panel/sesión y sólo se vacían después de aceptar la instrucción, sin reenvío automático al restaurar. El CI final pasó 32 fixtures nativos del transporte; L38–L46 registran pruebas y límites. Falta su prueba en iPhone. Conservar este borrador no equivale a archivar adjuntos ya enviados, sincronizar trabajos ni disponer de un catálogo offline de sesiones remotas.

| Unidad escrita | Comportamiento presente en el código | Aceptación pendiente |
| --- | --- | --- |
| Personaje | createEngineAsync, RigDirector y RigFx compartidos; arrastre, saludo, descanso, paseo, visibilidad y movimiento reducido/pausa | WKWebView, teclado, VoiceOver, consumo y coreografías más completas |
| Agente Apple | agent_step con generación guiada, descubrimiento de esquemas, validación, ejecución/observación, cancelación y revisiones humanas | Compilar la revisión actual e inferencia offline real con herramientas |
| Conversación y memoria | Una ventana de 120 tarjetas, archivo IndexedDB separado, búsquedas y recuperación de mensajes/recibos con procedencia, exportación y cola de guardado | Pruebas finales de los fixes de crash/revocación y persistencia real en WebKit; política de capacidad a largo plazo |
| Gentle Dot/Pi | Historial, actividad, preguntas humanas, steering y consulta/envío/detención de sesiones existentes | Host real compatible, continuidad entre motores y desconexión/restauración |
| Trabajos y reuniones | Blobs/versiones/CAS; transferencia por fragmentos con ACK durable; procesamiento Pi de audio y minutas trazables, recuperación y corrección local | WSS y modelo configurado verificados con datos sintéticos; faltan audio real y recorrido completo en el teléfono |
| Voz y Vision | Dictado local de comandos con assets/permisos/cancelación; OCR y códigos de imágenes/PDF con hash, páginas y cajas | Nueva compilación Swift y prueba real sin red |
| Credenciales y Compartir | Keychain, pairing, HTTPS/OAuth nativos, Share Extension/App Group e importación deduplicada | Firma/renovación SideStore, bloqueo del teléfono y Notas de Voz reales |
| Servicios externos | Ajustes por proveedor; OAuth público/PAT/API key; herramientas GitHub/Slack/Gmail/Odoo y MCP remoto | Registro/configuración de clientes reales, autorizaciones de cuentas y operaciones reales revisadas |
| Fuera de la aplicación | Live Activity opcional de turno local, estado genérico y miniatura estática; no hay overlay ni ejecución perpetua | Firma SideStore de dos extensiones, Lock Screen, actualización, consumo y aceptación en iPhone |

## Reglas del producto

- Una aplicación, una conversación y motores complementarios. La disponibilidad de Apple se consulta; no se deduce del nombre del iPhone.
- Conversar, conservar borradores y preparar trabajos básicos no requiere laptop, Pi, Tailscale ni VPS. Los servicios externos sí necesitan internet y credenciales propias de Capri.
- Una autorización de cuenta no aprueba acciones posteriores. Envíos, cambios, transferencias y operaciones de sesiones sensibles exigen revisión humana del destino y contenido exactos. El modelo no puede aprobarse a sí mismo.
- Guardado local, entrega al socket, ACK durable y trabajo terminado son estados distintos. Un timeout o reinicio no se convierte en éxito ni dispara una repetición de efectos.
- No incrustar secretos confidenciales ni copiar conexiones de Codex al iPhone. Priorizar infraestructura existente y tecnologías gratuitas.
- Notas de Voz graba reuniones. El micrófono de Capri sirve para instrucciones/correcciones breves; desktop mantiene su transcriptor configurado.

El usuario autorizó continuar y operar el repositorio sin nuevas preguntas de permiso. Las restricciones históricas de la fase inicial no revocan esa autorización. Las aprobaciones dentro del producto protegen acciones concretas de la asistente; son una frontera distinta de los permisos de desarrollo.

## Contratos y límites actuales

El arte personal 240 × 420 permanece fuera del Git público. El build personal nuevo lo incluirá offline en su bundle con SHA256 verificado; la entrega ccedf29 todavía requería importarlo manualmente. Arte, conversación, archivo y trabajos usan IndexedDB; no añade cifrado propio de Capri. URL del daemon y movimiento se recuerdan en localStorage. La app nativa conserva credenciales por cuenta/host en Keychain; el preview web no proporciona esa persistencia segura y mantiene el token manual sólo en memoria.

| Dato | Límite del código | Consecuencia |
| --- | --- | --- |
| Arte | PNG no vacío, 240 × 420, hasta 5 MiB | Validación y escritura confirmada antes de afirmar guardado |
| Ventana de conversación | 120 entradas, 32 000 caracteres por entrada, borrador hasta 8 000 | La ventana ya no es todo el historial; el archivo conserva mensajes capturados antes del recorte |
| Archivo offline | 10 000 registros / 64 MiB, hasta 512 KiB por registro | Sin borrado automático. La cuota/almacenamiento pueden bloquear nuevos envíos; exportar no libera cuota. No recupera mensajes perdidos antes de esta versión |
| Paso Apple | Instrucción UI hasta 2 400 caracteres; bridge agent_step hasta 8 000 escalares, respuesta hasta 768 tokens; ciclo hasta 16 pasos | Catálogo abreviado y esquemas por demanda; observaciones/contexto acotados. La ruta anterior respond conserva su límite 4 000/384 |
| Contexto del host | Hasta cuatro turnos locales recientes desde la última confirmación host; envoltura hasta 1 200 y petición total 8 000 | No envía el archivo completo por defecto; transportText ayuda a reconciliar el texto enviado |
| Enlace | Payload hasta 1 MB, handshake 12 s, reconexión hasta 30 s | No reenvía prompts al reconectar; el eco conversacional vence en 15 s y no es el ACK de trabajos |
| Trabajos | 100 trabajos, 10 archivos, 25 MiB por archivo / 50 MiB total, 100 versiones de hasta 200 000 caracteres | Las reuniones que excedan capacidad necesitan dividirse o una ampliación explícita, no truncamiento silencioso |
| Dictado | Comando temporal de hasta 90 s, texto hasta 32 000 y 2 000 segmentos | El CAF se elimina; no es un archivo reproducible de reunión |
| Vision | 12 MiB, 20 páginas PDF, hasta 2 400 px por dimensión, 200 000 caracteres | Evidencia con hash/cajas; PDF protegido o límites excedidos se rechazan explícitamente |
| Conexiones | Hasta 32 conexiones; credenciales Keychain hasta 16 KiB; registro hasta 1 000 ejecuciones | Capacidad finita y resultados inciertos conservados; sin limpieza automática que habilite duplicados |
| Gmail adjuntos | Hasta cinco, 800 kB totales antes de MIME | Límite del transporte nativo; no confundir con los 50 MiB de la bandeja |

Los estados de trabajo local/prepared/approved/sending/sent/uncertain/failed conservan revisiones y aprobación exacta. Editar invalida la aprobación. sent requiere recibo durable de ese snapshot; no significa minuta lista ni acción externa ejecutada. Un sending recuperado no se promueve por inferencia.

El archivo de conversación conserva fuente, fecha del evento, estado y recibos acotados. search_memory busca cuerpos reales de mensajes; recall_history permite ampliar el texto y las actividades por referencia. Una afirmación del usuario o un turno interrumpido no demuestra ejecución. El guardado pendiente sólo en memoria puede perderse si iOS termina el proceso antes de confirmar o exportar. Véase [memoria y recuperación](ios-conversation-memory.md).

## Motor Apple y herramientas

Foundation Models usa SystemLanguageModel.default y LanguageModelSession sin API key ni proveedor cloud alternativo. agent_step devuelve una decisión guiada; el runner valida el nombre, exige consultar el esquema y valida argumentos antes de ejecutar. Lecturas conocidas pueden volver a consultar progreso; una mutación repetida con los mismos argumentos canónicos se detiene. La cancelación descarta respuestas tardías y conserva recibos de operaciones ya confirmadas.

El registro incluye trabajos y archivos locales, Vision, memoria, sesiones Pi y transferencia/procesamiento. Las conexiones se descubren por demanda para no volcar todos sus esquemas en el contexto. Los resultados de herramientas y adjuntos son datos no confiables, no instrucciones. Las revisiones humanas están vinculadas al snapshot; cambian o caducan si el host cambia la pregunta, y ask_resolved sólo significa solicitud cerrada, no respuesta ejecutada.

El modelo local tiene contexto y capacidad limitados; no sustituye todo Pi. No hay fallback llama.cpp/MLX ni pesos propios distribuidos. Referencias: [Foundation Models](https://developer.apple.com/videos/play/wwdc2025/286/), [generación guiada](https://developer.apple.com/documentation/foundationmodels/adding-intelligent-app-features-with-generative-models) y [plugins móviles Tauri](https://v2.tauri.app/develop/plugins/develop-mobile/).

## Voz, Vision y Compartir

El plugin perception implementa SpeechAnalyzer/SpeechTranscriber local, es-MX/es-ES según disponibilidad, preparación explícita de assets, permiso de micrófono al usarlo, captura temporal y resultados finales con rangos. Dictar coloca texto en el composer existente; no lo envía automáticamente. La app cancela captura y procesamiento al suspender/interrumpir. El fix de CI usa el inicializador documentado con audioTimeRange en preparación, selección de formato y transcripción; su preflight Swift pasa en run 40634400355. No cambia a un servicio remoto y ese typecheck no acredita reconocimiento real. [Contrato de percepción](ios-perception.md).

Vision usa VNRecognizeTextRequest y VNDetectBarcodesRequest para imágenes y páginas PDF renderizadas. Conserva original/hash, orientación, cajas, confianza y códigos inertes. OCR no es comprensión multimodal general ni reconstrucción exacta de tablas; hay que revisar códigos y referencias antes de actuar.

La Share Extension está escrita y el configurador añade el target, App Group y capacidades. Copia bytes/manifiesto a un área privada compartida; la app importa de forma deduplicada y sólo acusa consumo después de confirmar IndexedDB. **Todavía no hay aceptación de Notas de Voz → extensión → app firmada con SideStore.** Archivos sigue disponible como alternativa explícita. Detalles en el [plugin de dispositivo](../apps/ios/plugin-device-bridge/README.md).

App Groups y firma gratuita requieren prueba efectiva de app y extensión, incluida renovación. La elegibilidad documental de una capacidad no demuestra que SideStore conserve los entitlements. No asumir APNs ni adoptar el entitlement Apple PushToTalk por usar un botón de dictado. [Capacidades Apple](https://developer.apple.com/help/account/reference/supported-capabilities-ios), [extensiones y contenedores](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html).

## Cuentas, pairing y servicios

Keychain precede a cualquier persistencia de secretos. Pairing usa un token de dispositivo reconocido por el daemon; el token maestro histórico no identifica presencia móvil por añadir una bandera. Hay regresiones de restauración tardía para no reutilizar un token de otro host ni reconectar tras Desconectar. La renovación SideStore, revocación y estado bloqueado aún necesitan pruebas reales. Notificaciones/presencia fuera de la app no quedan implementadas por tener pairing.

Ajustes muestra un solo formulario de conexión con campos según el servicio. Los metadatos usan CAS y las credenciales cuentas Keychain nuevas por rotación. Se revalida conexión/revisión al recuperar acceso y después de una aprobación sensible. Una renovación incierta queda bloqueada, sin repetir un refresh posiblemente consumido. OAuth y navegación del sistema son acciones de configuración humana, nunca herramientas del modelo.

| Servicio | Ruta escrita | Requisito externo y límites |
| --- | --- | --- |
| GitHub | PAT o device flow público; repositorios e issues, creación de issues | App/client ID propio para device flow. El alcance repo de privados concede escritura y la UI lo informa; cada mutación se revisa |
| Slack | PKCE público por ASWebAuthenticationSession; consulta de canales públicos/historial y envío de texto | App Slack con PKCE y callback capri-auth; scopes de usuario, sin bot scopes para este redirect; cuentas reales pendientes |
| Gmail | Cliente OAuth iOS con PKCE; búsqueda/lectura, envío MIME y adjuntos verificados | Client ID real del bundle. CAPRI_GOOGLE_CLIENT_ID debe incluir su esquema invertido en la IPA; se comprueba nativamente antes de consentir. Scopes/permisos reales pendientes |
| Odoo | API key, servidor/base, JSON-2 o JSON-RPC con UID; consulta, creación/edición de tareas | Versión, plan y permisos de la instancia. No se inventa OAuth genérico para Odoo |
| MCP remoto | Streamable HTTP, descubrimiento tools/list y llamadas con revisión exacta | Endpoint y credencial propia; no todos los transportes ni flujos OAuth MCP están implementados |

Guías: [OAuth público y rotación](ios-provider-oauth.md), [APIs directas](ios-direct-providers.md), [MCP](ios-mcp.md). No se ha autorizado ninguna cuenta real mediante estos nuevos módulos. La lista distingue credencial guardada de acceso efectivamente comprobado; quitar una conexión local no revoca el permiso del proveedor.

## Trabajos, reuniones y aprobaciones

El contrato móvil/daemon está escrito: IDs estables, snapshot de revisión, manifiesto y SHA-256, fragmentos, reanudación y ACK posterior a persistencia durable del host. Una reconexión consulta estado antes de decidir; no repite procesamiento ni escrituras por timeout. El backend se activó y tiene pruebas reales por WSS (L29–L31), incluyendo un solo procesamiento por manifiesto aprobado y resultado durable. El servicio desktop permaneció intacto. La validación desde el teléfono sigue separada de ese harness.

El recorrido requerido y modelado es: Notas de Voz → audio/transcripción Apple opcional → almacenamiento offline → transferencia aprobada → transcriptor de la computadora → contraste de fuentes → minuta frontier → borrador/correcciones/versiones → aprobación → acciones externas exactas. Aceptar la minuta no autoriza todas las comunicaciones derivadas.

El pipeline usa ffprobe/ffmpeg con restricciones, audio segmentado y LocalVoice del host; ModelRuntime de Pi genera la minuta sin herramientas. Se conservan hash/procedencia, segmentos y versión. Acuerdos, responsables, fechas, pendientes y riesgos distinguen confirmado/propuesta/inferencia. Nombres/fechas ausentes quedan null; validar estructura y citas no garantiza interpretación semántica correcta. Los tiempos son de segmentos, no alineación palabra por palabra. [Transferencia y minutas](ios-work-sync.md).

Las escrituras directas revisan cuenta, destino, contenido, campos, adjuntos por hash y revisión. Un journal se confirma antes de enviar. Respuesta recibida no implica éxito de negocio; rechazo se conserva explícito y fallo ambiguo queda uncertain. Gmail comprueba remitente autenticado; cambiar cuenta, adjunto o configuración invalida la revisión.

## Personaje y superficies de iOS

Se conserva el Capri 2D de PC y la referencia personal rosa/neón, verde ácido, violeta y oscuro. Movimiento, saludo, descanso, presencia y reacciones acompañan el hilo. El RoamDirector compartido busca espacios libres dentro del panel visible, evita controles y texto, y usa la secuencia de teleportación de PC para trasladarse. Teclado, reducción de movimiento y colocación manual restringen ese desplazamiento. No hay mascota flotante sobre otras apps ni Capri 3D.

La Live Activity de Lock Screen requiere prueba real de firma y respeta los límites de actualización del sistema; otros widgets siguen pendientes. No sustituirlos por una promesa de WKWebView animado permanentemente ni depender de Dynamic Island en iPhone 17e. Se mantienen pendientes VoiceOver, safe areas/teclado reales, consumo, memoria y suspensión. [ActivityKit](https://developer.apple.com/documentation/activitykit), [comparación del dispositivo](https://www.apple.com/iphone/compare/?modelList=iphone-17e,iphone-17).

## Gates para aceptar el proyecto completo

| Gate | Evidencia necesaria |
| --- | --- |
| Compilación del candidato | CI del SHA corregido, APIs Swift, app y Share Extension arm64, frameworks/Info.plist/entitlements requeridos, IPA y SHA-256 nuevos |
| Firma y autonomía | SideStore e instalación verificadas; modo avión/Wi-Fi apagado sin host/token, varios turnos Apple, herramientas locales, cancelación y bloqueo/restauración |
| Percepción y Compartir | Dictado/OCR reales offline con assets; permisos/errores; Notas de Voz llega íntegra y la extensión funciona después de renovar |
| Pi y reuniones | Host compatible desplegado expresamente, sesión real, transferencia interrumpida/ACK perdido, audio real, minuta/evidencia/versiones y corrección móvil |
| Servicios externos | Clientes/cuentas reales configurados, lectura directa con laptop apagada y escritura revisada; revocación/rotación/resultado incierto sin duplicación |
| Memoria y capacidad | Archivo >120, recuperación tras crash y cuotas; exportación verificable en iPhone; política explícita para capacidad llena sin borrar por sorpresa |
| Experiencia y superficies | Rig/cómic y gestos completos, teclado/safe areas/VoiceOver/texto grande, medición de energía/memoria, superficies legítimas que se decida incorporar |

No cerrar un gate con fixtures de otro nivel. Registrar comandos, SHA, Xcode/SDK/Tauri, artefacto/hash, firma/expiración, dispositivo/iOS reales y pasos offline/enlazados en el [log de Capri](../odd/tasks/capri-ios.md). Nunca adjuntar tokens, Apple ID, pairing, audio privado ni IPAs firmadas al repositorio o CI.
