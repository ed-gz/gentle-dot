# Voz local y lectura de documentos en Capri

El plugin `perception` añade instrucciones breves por voz mediante Apple SpeechAnalyzer y lectura local de imágenes/PDF con Apple Vision. Sus resultados son borradores y evidencia: ninguna función envía mensajes, ejecuta enlaces ni autoriza acciones externas.

**Estado:** implementación disponible con pruebas de límites en TypeScript y Rust. La compilación Swift y la prueba en un iPhone real se registran por separado en `odd/tasks/capri-ios.md`; estas pruebas de frontend no demuestran reconocimiento real.

## Integración de la aplicación

1. Añadir `tauri-plugin-perception = { path = "../plugin-perception" }` a `apps/ios/src-tauri/Cargo.toml` y `.plugin(tauri_plugin_perception::init())` al Builder.
2. Autorizar `perception:default` exclusivamente a la ventana principal empaquetada.
3. Incorporar `NSMicrophoneUsageDescription` en el Info.plist generado: «Capri usa el micrófono cuando dictas una instrucción. La transcripción se realiza en este iPhone.»
4. Compilar con SDK iOS 26 o posterior. El código de SpeechAnalyzer comprueba iOS 26 al ejecutarse. No usa las nuevas API de captura de iOS 27.
5. Importar las funciones de `apps/ios/src/perception.ts`. Ante errores, conservar el borrador anterior y mostrar el mensaje de la operación.

No se necesita `NSSpeechRecognitionUsageDescription`: no se usa SFSpeechRecognizer ni su servicio remoto. No se añade modo de audio en segundo plano, entitlement Apple PushToTalk, permiso permanente de fotos ni grabadora de reuniones.

## Contrato de voz

| Función TypeScript | Uso y resultado |
| --- | --- |
| `checkVoice()` | Estado de dispositivo, español, assets, permiso de micrófono y sesión. No abre permisos ni descarga modelos. |
| `prepareVoice()` | Acción explícita para instalar los assets compartidos de Apple. Puede requerir internet y espacio. |
| `startVoice()` | Pide micrófono cuando se usa; devuelve `sessionId` y límite de 90 segundos después de comenzar la captura. |
| `stopVoice(sessionId)` | Detiene captura, transcribe localmente y devuelve texto, idioma, duración y segmentos con `startSeconds`/`endSeconds`. |
| `cancelVoice()` | Cerca la operación actual y espera el cierre confirmado; el audio retenido para recuperación se conserva según su estado y destino. |

En la conversación se toca el micrófono para iniciar y se vuelve a tocar para detener y transcribir. El primer toque también inicia la preparación de assets cuando hacen falta; puede requerir internet y espacio. La transcripción queda como texto editable y no se envía automáticamente. Un contador de frontend puede llamar a `stopVoice` al límite; la captura nativa tiene su propio límite de 90 segundos incluso si ese contador falla.

La captura de una instrucción puede reservarse en almacenamiento nativo privado para recuperar el audio y la transcripción si se interrumpe la entrega al borrador. La liberación automática exige comprobar el recibo y su incorporación durable; los estados inciertos se conservan para revisión. También hay descarte y exportación explícitos, sin presentar audio incompleto como íntegro. Esta retención no sustituye Notas de Voz para reuniones. La captura intenta mostrar hipótesis provisionales de SpeechAnalyzer mientras se habla; no se agregan al borrador ni se envían automáticamente. Al terminar, SpeechAnalyzer procesa el CAF completo; un fallo de escritura o pérdida de muestras invalida la captura. No añade servidor ni proveedor alternativo. Después de instalar los recursos, la transcripción usa el modelo del dispositivo. Antes de analizar se comprueba el formato real; si es necesario, `AVAudioConverter` genera una copia acotada y el archivo se abre para análisis en Float32 sin reescribir la fuente. Una prueba sintética real de DictationTranscriber en macOS verificó la conversión y transcripción corregidas; el micrófono, SpeechAnalyzer y la recuperación aún requieren prueba en el iPhone. Ver [SpeechAnalyzer de Apple](https://developer.apple.com/videos/play/wwdc2025/277/) y [resultados provisionales de SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption).

El run macOS efímero 40863590657 probó voz sintética: transcribió un CAF Float32 de 48 kHz tras convertirlo, un archivo ya compatible sin modificar sus bytes y buffers Int16 en el API de resultados provisionales. Un control separado con buffers Float32 terminó con SIGTRAP y el job falló; el padre continuó y confirmó la liberación de la reserva de idioma. La matriz posterior transcribió el archivo convertido con lectura Float32, pero sus casos de lectura Int16 fallaron. Estos resultados se refieren a audio sintético en macOS, no al micrófono ni al comportamiento en iPhone; tampoco confirman que la vista previa Float32 funcione.

El run sintético macOS 40867241941 reprodujo un fallo del estado de captura:
un buffer PCM vacío se trataba como fallo de copia e impedía conservar las muestras
siguientes. La corrección ignora ese buffer sin declarar pérdida de audio; sigue
rechazando formatos cambiados y buffers sobredimensionados. El fixture usa buffers
sintéticos, no el micrófono, y por sí solo no demuestra que este fuera el origen
del error observado en el iPhone. El run público 40867535660 pasó la regresión
corregida y los fixtures nativos de captura, conservación y cancelación, además
del typecheck iOS con stubs de Tauri; no ejecutó la app ni el micrófono del teléfono.
Apple permite que el tap entregue bloques de un tamaño distinto al solicitado.
La fuente posterior divide bloques de hasta 65 536 frames en copias acotadas;
ante un bloque mayor o una cola llena marca la captura incompleta. El run público
40867923724 pasó la comparación muestra por muestra de bloques de 8193 frames en
mono y estéreo, el rechazo de 65 537 frames y el preflight nativo completo. El
rendimiento del callback y los tamaños que entrega el iPhone no están medidos.

La selección prioriza un transcriptor ya instalado en español para permitir dictar sin descargar recursos; si hay varios, prefiere `SpeechTranscriber`. También consulta `DictationTranscriber`, que Apple documenta como transcripción local para más dispositivos y locales. Cuando ninguno está instalado, prefiere descargar el modelo de `SpeechTranscriber` si es compatible. La preparación de assets, elección de formato y transcripción usan el mismo módulo seleccionado, opciones de entrega final y el atributo `audioTimeRange`. Si ninguno ofrece español, se indica que no está disponible. Esta ampliación requiere compilación con el SDK y prueba real de ambos caminos; las pruebas Node/Rust no verifican el reconocimiento nativo.

La app cancela captura/transcripción al perder primer plano, entrar en background o recibir una interrupción de audio. El diálogo inicial de permiso puede hacer que la app pierda actividad: se permite completar ese diálogo, pero un cambio real a background invalida el inicio. La cancelación también descarta resultados tardíos. Una instalación de assets ya iniciada la gestiona Apple y puede terminar aunque el usuario cancele el resultado de preparación en Capri.

Cada intento de dictado lleva un identificador propio a los comandos de preparación, inicio y cancelación. Una cancelación tardía sólo puede afectar a su intento; si llega antes del inicio, el puente recuerda que el intento se canceló y rechaza ese inicio. Los identificadores cancelados se conservan en un conjunto acotado por proceso; si se agota, se rechazan nuevos intentos hasta reiniciar Capri. El bridge conserva la variante sin identificador para versiones anteriores. Esto protege contra reordenamientos del transporte; aún requiere compilación y pruebas en iPhone.

Los segmentos son referencias al audio temporal del comando; tras borrarlo no constituyen un archivo de evidencia reproducible. **La evidencia de reuniones requiere conservar el audio original importado desde Notas de Voz y sus referencias temporales por otra ruta.**

## Contrato de Vision

`recognizeDocument(file)` acepta PNG, JPEG, HEIC, HEIF, WebP, TIFF de una página o PDF. Los límites son 12 MiB, 20 páginas PDF, imagen de trabajo de hasta 2400 píxeles por dimensión, 2000 observaciones por página y 200000 caracteres de salida. Los PDF protegidos y las imágenes de varias páginas se rechazan explícitamente. No se descartan páginas en silencio.

La función devuelve:

- `source`: nombre, MIME, bytes y SHA-256 del archivo exacto. El frontend calcula el hash independientemente y comprueba la respuesta nativa.
- `pages`: número, resolución procesada, texto y observaciones. Cada observación contiene texto/código, confianza y caja normalizada con origen abajo a la izquierda.
- `text`, `engine: "apple-vision"`, `coordinateSystem` y avisos de revisión.

Las páginas PDF se renderizan y reconocen con OCR. La imagen original se orienta mediante sus metadatos antes de reducirse. Se desactiva la corrección ortográfica para conservar códigos técnicos; el OCR aún puede equivocarse. El orden de lectura es una ayuda geométrica y no reconstruye tablas ni columnas complejas. Los códigos QR y de barras son cadenas inertes, nunca navegación o ejecución automática.

El caller debe guardar el archivo original en la bandeja cuando necesite evidencia durable. El plugin no altera ni conserva los bytes originales. `cancelDocument()` y el paso a background invalidan resultados pendientes. Vision trabaja fuera del hilo de interfaz, una operación a la vez; un watchdog cancela después de 120 segundos. Un documento que exceda los límites debe dividirse o delegarse al host con confirmación durable.

## Verificación de aceptación nativa

La conversación puede invocar Vision mediante `file_ocr` del registro `agent-tools.ts`, sobre un adjunto ya guardado. Ese registro también permite consultar capacidades, listar/leer/crear/editar trabajos, añadir versiones y leer archivos de texto con hash. Las escrituras locales usan la revisión atómica de la bandeja y no cambian estados de aprobación o sincronización. `external_prepare` solamente devuelve un intent validado con `state: draft`, `persisted: false` y `executed: false`; el caller debe presentarlo y guardarlo en su flujo de revisión antes de cualquier ejecución externa. Ninguna herramienta acepta una aprobación generada por el modelo.

El registro es inyectable y valida argumentos tanto al seleccionar como al ejecutar. Los resultados largos indican recortes y paginación; OCR devuelve muestras de evidencia explícitamente limitadas, con hash y número de página para contrastarlas con el original. Los adaptadores de host se añaden como herramientas independientes. La cancelación no borra un comprobante de escritura local que ya se confirmó.

- [ ] Compilación con Xcode/SDK real, permiso de micrófono presente en la IPA final.
- [ ] Primer uso: aceptar/rechazar permiso; rechazar no borra el borrador ni bloquea la app.
- [ ] Preparación de assets con internet; estado honesto al faltar assets o español.
- [ ] Modo avión, Wi-Fi apagado, host inaccesible: dos comandos en español con resultados reales.
- [ ] Cancelación durante captura y transcripción, bloqueo/desbloqueo, cambio de app, interrupción de audio, límite de 90 segundos.
- [ ] Error técnico fotografiado, imagen rotada, QR, PDF multipágina y PDF protegido; cajas y páginas corresponden al original.
- [ ] VoiceOver, texto grande, controles de detener/cancelar, indicador de micrófono y memoria durante documentos grandes.

Pruebas de fronteras: `node --test apps/ios/test/perception.test.mjs`; tras integrar Cargo, `cargo test --offline --locked --manifest-path apps/ios/src-tauri/Cargo.toml -p tauri-plugin-perception --lib`.

## Fuentes primarias

El flujo de transcripción usa la secuencia oficial `analyzeSequence(from:)`, seguida de `finalizeAndFinish(through:)`, y los assets gestionados por Apple. Referencias: [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer), [formatos de AnalyzerInput](https://developer.apple.com/documentation/speech/analyzerinput), [WWDC 2025: SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/), [ejemplo oficial](https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app), [permiso de micrófono](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:)).

Configuración del transcriptor: [inicializador explícito](https://developer.apple.com/documentation/speech/speechtranscriber/init(locale:transcriptionoptions:reportingoptions:attributeoptions:)), [presets del SDK](https://developer.apple.com/documentation/speech/speechtranscriber/preset) y [audioTimeRange](https://developer.apple.com/documentation/speech/speechtranscriber/resultattributeoption/audiotimerange).

La alternativa local se basa en [DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber), [su inicializador](https://developer.apple.com/documentation/speech/dictationtranscriber/init(locale:contenthints:transcriptionoptions:reportingoptions:attributeoptions:)) y [sus locales soportados](https://developer.apple.com/documentation/speech/dictationtranscriber/supportedlocale(equivalentto:)).

La lectura usa las solicitudes estables de [texto Vision](https://developer.apple.com/documentation/vision/vnrecognizetextrequest) y [códigos Vision](https://developer.apple.com/documentation/vision/vndetectbarcodesrequest). El puente sigue el patrón de [plugins móviles Tauri](https://v2.tauri.app/develop/plugins/develop-mobile/) ya utilizado por el motor local de Capri.
