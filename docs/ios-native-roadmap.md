# Capri iOS: autonomía local y colaboración con Gentle Dot

Capri debe ser una asistente personal operativa de TI con el personaje 2D de PC, una conversación continua y dos motores complementarios: Apple en el iPhone y Pi/Gentle Dot en la laptop. Este documento conserva el alcance solicitado y los criterios para aceptar cada entrega. **Código escrito, pruebas con fixtures, compilación nativa y validación en el teléfono son evidencias distintas.**

Corte de requisitos: **27 de octubre de 2026, America/Monterrey**. Trabajar exclusivamente en `/home/egarza/gentle-dot-capri`, rama `fix/android-capri-motion-mobile`; `gentle-dot` es el proyecto viejo y no es una base alternativa. El origin de este checkout sigue siendo `https://github.com/ed-gz/gentle-dot.git`.

## Próxima entrega verificable

1. Conservar la evidencia local ya obtenida: 52/52 Node, 15/15 navegador, 2/2 Rust, typecheck y build frontend. La suite incluye arte restaurado, texto al 200 %, viewport pequeño y landscape; repetir ante nuevos cambios relevantes.
2. Conservar la IPA ya verificada en run 40627109957, código 1ff5d38, Xcode 26.3/SDK 26.2; SHA-256 y entrega en el registro L18. Repetir el gate ante cambios nativos.
3. Instalar esa misma IPA mediante la ruta SideStore validada y demostrar conversación real con modo avión, Wi-Fi apagado, sin token y con laptop apagada.
4. Validar continuidad al pasar entre Apple y Gentle Dot. Después avanzar a Keychain/pairing, voz, visión, importación nativa y sincronización durable.

La [guía de instalación](ios-sidestore.md) describe el procedimiento. El [registro de trabajo](../odd/tasks/capri-ios.md) conserva resultados e historia, incluido L7 de fase 1.

## Estado y evidencia

La fase 1 tiene evidencia heredada en iPhone 17e, con iOS 27.2 informado por el usuario: run `40600744611`, firma SideStore, conexión al daemon y confirmación «se mueve». La fase 2 comenzó desde HEAD `98ca9ac`; al recibir el handoff sus cambios seguían locales, sin commit, push, nueva IPA ni instalación.

| Superficie | Código de fase 2 presente | Aceptación pendiente |
| --- | --- | --- |
| Personaje y shell | Cuatro secciones; motor, rig y FX 2D compartidos; arrastre, saludo, descanso, paseo y visibilidad; preferencias de movimiento | QA completo de layout/accesibilidad y comportamiento en WKWebView real |
| Conversación | IndexedDB, borrador, orígenes Apple/Gentle Dot, contexto acotado y recuperación de pendientes | Inferencia Apple real; sesión real de Pi; suspensión, restauración y continuidad en teléfono |
| Apple local | Plugin Swift/Rust/Tauri con disponibilidad, respuesta, cancelación y reset; Swift/IPA verificados en CI | Instalar e inferir sin red en el iPhone |
| Enlace | Handshake validado, historial, deltas, finales, aborto y reconexión | No existe ACK durable de trabajo; autorizaciones del host se revisan en laptop |
| Trabajos | Archivos locales, revisiones, versiones, eliminación y estados de aprobación | Share Extension, transferencia, procesamiento, ejecución externa y confirmación durable |
| Voz, visión, conectores y superficies nativas | Sin implementación aceptada | Requieren unidades propias; la existencia de frameworks no demuestra integración |

Evidencia recibida con el handoff: 42/42 tests Node, typecheck iOS, Cargo check offline, 2/2 tests Rust y 4/4 tests Playwright de bandeja. Shell quedó en 4/5: el caso de arte falló inicialmente al recargar y no llegó a sus comprobaciones posteriores de layout. Dos fixes de historial/streams se aplicaron después de la última suite completa. Estos resultados describen ese corte. La continuación ya verifica 52/52 Node, 15/15 Playwright, 2/2 Rust, TypeScript y build frontend; el registro L12–L16 conserva diagnóstico y límites. El bloqueo técnico de Git quedó resuelto al aplicarse acceso completo; las unidades están confirmadas y el código 1ff5d38 se publicó para CI. La repetición de navegador con API Tauri 2.2.0 pasó 15/15 en 34.1 s. Swift e IPA ya pasan en run 40627109957 (L18); instalación e inferencia en dispositivo siguen pendientes.

## Reglas del producto

| Requisito | Consecuencia de implementación |
| --- | --- |
| Una app y una conversación | El cambio de motor conserva el hilo, el origen y el estado de cada turno; no crea dos chats incompatibles |
| Autonomía del teléfono | Conversar y conservar trabajos básicos no depende de Pi, Tailscale, laptop ni VPS; la disponibilidad real de Apple se comprueba |
| Motores complementarios | Apple interpreta, prepara texto y ejecutará herramientas controladas; Pi aporta modelos frontier, memoria y herramientas de desktop |
| Conexiones directas | Gmail, Slack, GitHub y Odoo funcionan con internet y credenciales propias de Capri; no heredan las conexiones de Codex |
| Revisión obligatoria | Crear issues, enviar comunicaciones o modificar información exige aprobación explícita vinculada al contenido exacto |
| Conservación offline | Guardado local y sincronización confirmada son estados distintos; fallos o cierres no se convierten en éxito |
| Arquitectura ampliable | Adaptadores y contratos tipados para añadir conexiones/herramientas sin acoplarlas al personaje |
| Infraestructura | Priorizar tecnologías gratuitas e infraestructura existente; no añadir VPS obligatorio para funciones básicas |
| Voz por dispositivo | iPhone usa Apple; desktop conserva su transcriptor configurado |
| Honestidad de superficies | No presentar mocks como función operativa ni prometer servicios Android en iOS |

Android queda abandonado: no reactivar T47 ni portar el servicio Java/Capacitor. Se pueden reutilizar contratos de pairing, revisiones y protocolo existentes tras revisarlos. No mezclar `origin/feat/android-orchestration` como atajo: el handoff documenta 144 conflictos y una base antigua. La entrega iOS tampoco implica desplegar o reiniciar desktop.

## Contratos locales ya escritos

El shell importa directamente `createEngine`, `RigDirector` y `RigFx` de `packages/ui/src/capri2d`. Conserva el PNG personal fuera del bundle: 240 × 420, no vacío y hasta 5 MiB. El arte, conversación y trabajos viven en IndexedDB; únicamente URL y preferencia de movimiento van a localStorage. El token del daemon permanece en memoria. IndexedDB no es Keychain ni añade cifrado propio de Capri.

| Dato | Límite actual | Implicación |
| --- | --- | --- |
| Conversación | 120 entradas, 32 000 caracteres por entrada, borrador 8 000 | No es un archivo completo de memoria de largo plazo |
| Contexto Apple | Hasta cuatro turnos completos; solicitud bridge de 4 000 escalares Unicode; mensaje UI de 2 400; respuesta de 384 tokens | Sesión nativa reiniciada antes de cada petición y contexto reconstruido; no prometer memoria ilimitada |
| Contexto host | Hasta cuatro turnos locales desde último turno host confirmado; envoltura hasta 1 200 caracteres y solicitud total hasta 8 000 | Preservar instrucción actual y alias `transportText` para reconciliar historial sin duplicar tarjetas |
| Transporte | Payload de hasta 1 MB, handshake de 12 s, backoff hasta 30 s | No reenviar prompts automáticamente; envío al socket no acredita recepción durable |
| Trabajos | 100 trabajos; 10 archivos por trabajo; 25 MiB por archivo y 50 MiB por trabajo | Las reuniones largas pueden requerir ampliar/migrar almacenamiento antes de aceptarlas |
| Versiones | 100 por trabajo, 200 000 caracteres por versión | Mantener política visible de capacidad, exportación y recuperación |

Estados de trabajos: `local`, `prepared`, `approved`, `sending`, `sent`, `uncertain`, `failed`. Editar o crear versión invalida aprobación; reintentar tras fallo/incertidumbre exige revisión nueva. Un `sending` recuperado no se promueve a `sent`. La UI actual sólo opera localmente y permite cargar instrucciones al composer sin enviarlas automáticamente.

El enlace espera eco del host y marca sin confirmar si no llega en 15 s. Esto mejora la conversación, pero **no sustituye un ACK durable correlacionado**. Detener un stream vinculado afecta al trabajo compartido del daemon. Los permisos del host aún no pueden responderse desde la UI iOS.

## Motor Apple y herramientas

`SystemLanguageModel.default` y `LanguageModelSession` ofrecen la ruta de inferencia local. La disponibilidad depende de dispositivo, configuración, región/idioma y assets; debe consultarse antes de cada uso relevante y comunicarse con causas accionables. El bridge distingue modelo no preparado, Apple Intelligence apagado, dispositivo no elegible, idioma no soportado y OS/bridge ausente. Un SDK sin FoundationModels ahora debe fallar al compilar: no se acepta una app degradada sin el motor. [Apple: Foundation Models](https://developer.apple.com/videos/play/wwdc2025/286/).

El plugin actual sólo genera texto. Debe compilarse y probarse antes de extenderlo. Las siguientes unidades añadirán `@Generable`/`@Guide`, registro de herramientas y validación independiente de argumentos; la salida estructurada no concede autorización para producir efectos externos. Una herramienta de escritura prepara una propuesta revisable y el ejecutor comprueba su aprobación exacta. [Apple: generación guiada y herramientas](https://developer.apple.com/documentation/foundationmodels/adding-intelligent-app-features-with-generative-models).

No hay API key ni proveedor cloud alternativo en este motor. llama.cpp/MLX y pesos propios son alternativas futuras con costos de memoria y distribución; no forman parte de la entrega. Swift es un paquete de plugin móvil Tauri registrado desde Rust y limitado por capabilities a la ventana principal empaquetada. [Tauri: plugins móviles](https://v2.tauri.app/develop/plugins/develop-mobile/).

## Voz, visión y material de reuniones

**SpeechAnalyzer:** implementar push-to-talk local para instrucciones y correcciones. Seleccionar locale soportado, comprobar/descargar assets antes del modo offline, capturar con permiso de micrófono al usarlo y cancelar/limpiar sesión de audio al terminar o suspender. Separar resultados provisionales de finales y preservar `audioTimeRange` cuando exista. El botón de dictado no necesita adoptar el framework/entitlement Apple PushToTalk ni copiar por inercia permisos de `SFSpeechRecognizer`. La API de Apple usa `SpeechTranscriber`, `AssetInventory` y rangos temporales del audio; el funcionamiento offline requiere assets ya preparados. [Apple: SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/).

**Vision:** importar fotografías/documentos y extraer texto, códigos de error y códigos de barras. Conservar original, orientación, idioma, observaciones y ubicación; mostrar incertidumbre para corregir un código antes de actuar. Los PDF requieren una ruta explícita para páginas y texto existente o renderizado. OCR no equivale a comprensión multimodal general. `RecognizeTextRequest` entrega observaciones y soporta configuración de idioma; Vision dispone también de detección de códigos y análisis de documentos. [Apple: Vision](https://developer.apple.com/documentation/vision), [reconocimiento de texto](https://developer.apple.com/documentation/vision/recognizetextrequest).

**No construir una grabadora de reuniones que sustituya Notas de Voz.** El flujo requerido es:

1. Grabar en Notas de Voz; compartir audio a Capri e importar opcionalmente transcripción Apple.
2. Conservar el material y la solicitud aunque Gentle Dot esté desconectado.
3. Transferir a la laptop con confirmación durable y recuperar resultados al volver a conectar.
4. Procesar audio con el transcriptor configurado en desktop y contrastar con el texto Apple sin sustituir silenciosamente el original.
5. Generar con un modelo frontier una minuta enriquecida y mostrar el borrador en Capri.
6. Corregir por voz con SpeechAnalyzer; conservar cada revisión hasta aprobación.
7. Preparar issues, cambios de Odoo y comunicaciones sugeridas; ejecutar sólo las acciones aprobadas.

La minuta debe distinguir **acuerdo confirmado, propuesta e inferencia**. Registrar acuerdos, responsables confirmados, fechas, pendientes, riesgos y evidencia temporal verificable. No completar responsables ni fechas ausentes con suposiciones. El contrato futuro debe enlazar trabajo/revisión, hash y duración del audio, transcripciones versionadas, segmentos con inicio/fin, borrador y versión aprobada. Si la transcripción importada no trae tiempos, no inventarlos: alinear contra el audio o marcar la referencia como pendiente. Aceptar una minuta no autoriza automáticamente todas sus acciones externas.

## Compartir desde Notas de Voz y firma

Hoy la ruta operativa de código es **Notas de Voz → guardar en Archivos → selector de Capri**. Capri todavía no figura como destino nativo en Compartir.

La Share Extension deberá copiar audio/transcripción a un contenedor compartido mediante una operación atómica, conservar manifest/hash y terminar pronto; la app procesará después. App y extensión tienen sandboxes distintos y necesitan App Group para ese almacenamiento compartido; la extensión no es un worker permanente. [Apple: datos compartidos](https://developer.apple.com/documentation/technologyoverviews/shared-data), [escenarios de extensiones](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html).

El handoff informa que la tabla de Apple marca App Groups para la cuenta gratuita. La [tabla oficial de capacidades](https://developer.apple.com/help/account/reference/supported-capabilities-ios) es la referencia de elegibilidad; **eso no prueba que SideStore firme ambos targets conservando o reescribiendo correctamente el grupo**. El gate previo es una extensión mínima: firmar, recibir un audio real desde Notas de Voz, comprobar bytes en la app, cerrar/reabrir y renovar ambos targets. Registrar entitlements efectivos sin secretos. Si falla, mantener Archivos como alternativa explícita mientras se resuelve; no declarar Share Extension completada ni cambiar a membresía pagada por inferencia.

## Credenciales, pairing y conectores

Keychain precede a persistir tokens. Añadir almacenamiento nativo por host/cuenta, reemplazo atómico al renovar, borrado al desvincular y errores comprensibles cuando el teléfono está bloqueado. Probar el efecto de renovación y eventual cambio de identificador al firmar con SideStore. No trasladar tokens a localStorage, IndexedDB, logs ni repositorio para resolver el pairing. [Apple: Keychain Services](https://developer.apple.com/documentation/security/keychain-services).

El daemon reconoce presencia móvil mediante **token de dispositivo emparejado**; el token maestro de fase 1 no se vuelve móvil agregando una bandera al `hello`. Reutilizar el contrato de `apps/mobile/src/pairing.ts` tras revisar compatibilidad. Agrupar avisos al usar PC no debe borrar contenido; preguntas/permisos siguen requiriendo atención. La cabecera nativa de opt-out no se puede añadir desde un WebSocket web estándar. Pairing, presencia y notificaciones son una entrega distinta; APNs no se presume disponible con firma gratuita.

Cada adaptador debe declarar cuenta/destino, scopes, herramientas de lectura/escritura, límites, errores, refresh/revocación y estrategia de resultado incierto. La autenticación abre una sesión del sistema o el SDK apropiado, verifica callback y `state`, usa PKCE donde el proveedor lo soporte y conserva tokens en Keychain. No incrustar un secreto confidencial en la app. [Apple: ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

| Servicio | Ruta candidata y condición de aceptación |
| --- | --- |
| Gmail | Cliente OAuth iOS y scopes mínimos por operación; usar Google Sign-In/AppAuth apropiado, no autorización dentro del WKWebView de Capri. Revisar consentimientos/verificación del proyecto y rotación. [Google iOS](https://developers.google.com/identity/sign-in/ios/start-integrating), [buenas prácticas](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) |
| Slack | PKCE público disponible; custom URI requiere PKCE y tokens rotativos, refresh tokens de 30 días, sin bot scopes para ese redirect. Registrar una app y scopes de usuario compatibles; habilitar PKCE es un cambio de configuración no reversible sin soporte. No hacerlo automáticamente. [Slack: PKCE](https://docs.slack.dev/authentication/using-pkce/) |
| GitHub | Seleccionar GitHub App/OAuth o PAT de alcance mínimo según operaciones y acceso real. Verificar exchange/redirect compatible con cliente público; no asumir que PKCE elimina cualquier requisito de secreto de todos los tipos de app. No incluir private keys de instalación en el teléfono. [GitHub: tokens de usuario y PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) |
| Odoo | Confirmar versión, plan y API de la instancia antes de elegir JSON-2/RPC; usar credencial limitada y rotación nativa. No asumir OAuth PKCE de serie ni que las credenciales del entorno desktop se transfieren. [Odoo 19: JSON-2](https://www.odoo.com/documentation/19.0/developer/misc/api/odoo.html) |
| MCP remoto | Descubrir capacidades y autenticación del servidor concreto; mantener la misma revisión de operaciones. Conectar un MCP no concede aprobación de escrituras |

## Sincronización durable y aprobación exacta

La transferencia futura necesita IDs estables por trabajo/adjunto/operación, hash de contenido, revisión, persistencia atómica del lado host y ACK correlacionado después de confirmar esa persistencia. Soportar interrupción y deduplicación, distinguir subida parcial de material completo, recuperar estado después de reconectar y evitar repetir una acción por timeout. Añadir el contrato del host en una unidad revisable; la bandeja local por sí sola no lo implementa.

Una aprobación debe identificar operación, servicio/cuenta, destinatario o registro, campos/texto, adjuntos por hash, revisión y fecha de aprobación. Cualquier cambio invalida el permiso. Antes de ejecutar, comparar esa identidad con la propuesta actual y comprobar revocación/caducidad aplicable. Un fallo de red tras enviar puede quedar `uncertain`: consultar evidencia del proveedor antes de reintentar; nunca interpretar ausencia de respuesta como ausencia de efecto.

Las herramientas locales y frontier comparten este contrato. La aprobación en el iPhone y las preguntas/permisos de Pi necesitan un protocolo correlacionado específico; un botón visual que no envía respuesta verificable no cumple el requisito.

## Personaje y superficies permitidas

Conservar la referencia personal `outputs/capri-pc-referencia.png` del handoff y el Capri 2D existente: rosa/neón, verde ácido, violeta, fondo oscuro, viñetas angulares de cómic y acciones claras. La identidad incluye desplazamiento táctil, paseo, saludo, descanso, apariciones/desapariciones y reacciones a pensar, hablar, error y atención requerida. La UI no debe reducirlo a un avatar estático de chat.

El paseo actual vive dentro de la escena; aparición/desaparición es una transición de visibilidad. La misma escena acompaña al chat. Completar coreografías con el rig/director/FX existentes, sin volver a sprites antiguos ni Capri 3D. Respetar safe areas, teclado, VoiceOver, texto grande, movimiento reducido, consumo y suspensión; no incrementar animación fuera de primer plano.

Widgets/Lock Screen y Live Activities son superficies separadas que requieren SwiftUI/WidgetKit y pruebas de firma. ActivityKit permite mostrar estado de trabajos; el sistema gobierna actualizaciones y animaciones y no ofrece la misma escena WKWebView continuamente animada. No diseñar una dependencia de Dynamic Island para iPhone 17e ni un overlay de sistema sobre otras apps. [Apple: ActivityKit](https://developer.apple.com/documentation/activitykit), [actualizaciones de Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [comparación iPhone 17e/iPhone 17](https://www.apple.com/iphone/compare/?modelList=iphone-17e,iphone-17).

## Unidades de entrega y gates

| Orden | Unidad | Depende de | Evidencia para cerrar |
| --- | --- | --- | --- |
| G1 | Estabilizar fase 2 web | Código local heredado | Suite completa actual, build producción y QA pequeño/landscape/200 %; causas de fallos registradas |
| G2 | Compilar Apple/Tauri | G1 y SDK correcto | CI del SHA exacto; Swift compilado; app arm64 y assets dentro de IPA; hash de artefacto |
| G3 | Autonomía real | G2 e instalación | Dos o más turnos en modo avión/Wi-Fi off, sin token/laptop; cancelación, bloqueo y restauración; errores de disponibilidad honestos |
| G4 | Conversación enlazada | G3 y host disponible | Sesión real Pi, cambio de motor conservando contexto, historial ordenado, desconexión/interrupción sin duplicados ni falso éxito |
| G5 | Keychain y pairing | G3 | Token de dispositivo reconocido, cierre/reinicio/bloqueo, revocación y renovación SideStore; ausencia de secretos en almacenamiento web/logs |
| G6 | SpeechAnalyzer y Vision | G3; almacenamiento local | Voz/OCR reales sin red con assets preparados; permisos denegados, locale no disponible, cancelación y resultados corregibles |
| G7 | Share Extension mínima | G2; prueba firma/App Group | Audio de Notas de Voz y texto opcional llegan íntegros; persistencia tras cierre y renovación; archivos corruptos/límites rechazados |
| G8 | Sincronización de trabajos | G5; contrato durable host | Transferencia interrumpida, duplicada, reanudada y ACK perdido sin pérdida ni ejecución duplicada; hashes y revisiones conciliados |
| G9 | Minutas con evidencia | G6/G8; pipeline Pi | Audio → transcripciones → segmentos → versiones; corrección móvil y distinción acuerdo/propuesta/inferencia; fechas/personas no inventadas |
| G10 | Herramientas/conectores | G5; aprobación exacta | Con laptop apagada e internet, lectura real y escritura autorizada; cambios invalidan aprobación, revocación y resultado incierto cubiertos |
| G11 | Presencia y superficies | G5; firma/capacidades verificadas | Avisos sin pérdida del chat, superficies soportadas del iPhone real, consumo y accesibilidad medidos |

Voz/visión, prueba de Share Extension y diseño de contratos pueden avanzar en paralelo cuando no oculten el gate nativo. Cada unidad mantiene pruebas y documentación junto al cambio; no es necesario juntar todas las funciones en una única IPA imposible de revisar.

## Registro de aceptación de cada IPA

Completar en `odd/tasks/capri-ios.md` al obtener evidencia, sin sustituir pruebas de dispositivo por fixtures:

| Campo | Valor pendiente de evidencia |
| --- | --- |
| SHA, rama y cambios incluidos | Registrar revisión exacta |
| Node/TypeScript/Rust/build frontend | Comandos, resultados y fecha |
| Navegador | Motor/versión, viewport, fixtures y fallos conocidos |
| CI | URL/run, Xcode, SDK, Tauri y resultado Swift |
| Artefacto | Nombre y SHA-256 de IPA unsigned |
| Instalación | Herramienta, versión, bundle ID efectivo y fecha de expiración |
| Dispositivo | Modelo y versión iOS verificados; no inferidos del SDK |
| Offline / enlazado | Pasos ejecutados, resultado y límites por separado |
| Accesibilidad / energía | Teclado, safe areas, VoiceOver, texto grande, reducción de movimiento, memoria y suspensión |

Los comandos de repetición están en la [guía de instalación](ios-sidestore.md). No adjuntar tokens, Apple ID, pairing, audios privados ni IPAs firmadas al registro o a CI.
