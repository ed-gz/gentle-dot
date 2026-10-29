# Trabajos durables, minutas y sesiones Pi desde Capri

Capri puede conservar trabajos y adjuntos offline, transferir una revisión aprobada al daemon con confirmación durable, recuperar un ACK perdido y preparar minutas con evidencia. Las herramientas de conversación también consultan sesiones Pi existentes y proponen instrucciones para ellas. El código de este documento no implica despliegue del daemon ni validación de inferencia en el iPhone.

## Recorrido operativo

1. Crear o importar un trabajo. Las importaciones nativas copian fragmentos a IndexedDB y comprueban los bytes persistidos antes de publicar el trabajo. La extensión Compartir espera la confirmación local antes de retirar su copia; Notas de Voz conserva su original. Una copia incompleta se puede liberar o reintentar sin borrar la fuente nativa.
2. Revisar el contenido en la conversación. `work_sync` presenta manifiesto, revisión y hashes; una aprobación corresponde únicamente a esos bytes y ese host.
3. Transferir. `begin`, `chunk` y `commit` usan el mismo `transferId`. `sent` sólo aparece después de un recibo correlacionado y durable.
4. Solicitar la minuta. `work_process` requiere una aprobación separada de esa revisión confirmada. El resultado siempre tiene `requiresReview: true`.
5. Recuperar el resultado con `work_result`. Queda en `WorkItem.result`, disponible offline. `work_correct` conserva evidencia y adjuntos en un trabajo nuevo y editable, inicialmente sin aprobación.

El listado nativo separa manifiestos ilegibles por identificador y permite recuperar los demás. La interfaz muestra cada identificador afectado y conserva la copia nativa, sin confirmarla ni eliminarla; puede intentarse de nuevo si vuelve a ser legible o volver a compartir el original cuando esté disponible. Un error de lectura o cuota tampoco confirma el elemento. Esta recuperación está probada con navegador simulado y fixture Swift; falta validar la extensión y firma en el iPhone.

## Qué confirma cada respuesta

| Respuesta | Significado |
| --- | --- |
| Escritura IndexedDB completada | La operación local terminó; no confirma transferencia. |
| `uploading.offsets` | El host confirmó esos bytes después de `fsync`; todavía no confirma el trabajo completo. |
| `committed.receipt` | El host verificó hashes y guardó el manifiesto y adjuntos de la revisión. No ejecutó una tarea. |
| `processing.running` | Se registró un intento de preparar un borrador. |
| `processing.ready` | Hay una minuta validada estructuralmente y pendiente de revisión humana. |
| Sesión Pi `accepted` / `queued` | El adaptador recibió la instrucción; no confirma consumo ni finalización. |
| Sesión Pi `delivered` | Un evento de mensaje real de Pi confirmó consumo. Consultar la sesión para saber el resultado. |

## Transporte y almacenamiento

El [contrato compartido](../packages/protocol/src/work-sync.ts) valida campos, tamaños, identificadores y hashes. El hash SHA-256 cubre el JSON canónico del manifiesto, incluida la revisión, la instrucción, los archivos y cada versión histórica de texto. Las versiones viajan como adjuntos `role: "version"`; no se descarta silenciosamente el historial.

El [almacén del daemon](../packages/daemon/src/work-sync.ts) trabaja bajo `<dataDir>/work-inbox/<namespace>/<transferId>`. El namespace proviene del identificador autenticado del dispositivo, resuelto por `MobileAccess.deviceIdForToken`; el acceso maestro usa un namespace local estable separado. El cliente no elige el namespace y los tokens nunca se guardan en esos archivos.

- Escrituras serializadas; archivos privados, rutas derivadas de IDs validados, apertura sin seguir enlaces simbólicos.
- Fragmentos de hasta 64 KiB. Un fragmento repetido debe contener exactamente los mismos bytes.
- `commit` verifica tamaños y SHA-256, hace `fsync` del registro temporal, `rename` y `fsync` del directorio antes del ACK.
- `status` recupera desplazamientos o el recibo estable después de reiniciar. Una revisión no puede reutilizarse bajo otra transferencia para eludir deduplicación.
- Cuota por dispositivo: 100 transferencias y 512 MiB reservados en el host. Cada trabajo admite 10 adjuntos originales y 100 versiones, con audio hasta 128 MiB por archivo, otros archivos hasta 25 MiB y 256 MiB en adjuntos; el total con versiones no supera 336 MiB. El espacio disponible en iPhone y host puede ser menor. Una laptop antigua conserva el límite de 25/50 MiB: Capri comprueba el anuncio autenticado del host antes de iniciar la transferencia y conserva localmente el material que no puede enviar.
- La eliminación local y la revocación de un dispositivo no borran automáticamente los datos del host. La gestión de retención remota requiere una unidad posterior; una nueva vinculación no hereda automáticamente el namespace anterior.

El [dispatcher iOS](../apps/ios/src/work-sync.ts) conserva un snapshot inmutable en IndexedDB antes de enviar. Los cambios de contenido invalidan la aprobación. Ante desconexión o un ACK perdido mantiene `uncertain`; recuperar consulta primero `status`. No vuelve a ejecutar procesamiento ni acciones externas por reconectar. Si el host no encuentra el snapshot, exige revisión nueva antes de otro intento.

Los hashes usan WebCrypto cuando está disponible y CryptoKit por el bridge nativo, en fragmentos, cuando WKWebView no ofrece `crypto.subtle`. Los identificadores tienen un fallback UUIDv4 basado en `getRandomValues`, sin aleatoriedad débil.

## Minutas y evidencia

El [procesador](../packages/daemon/src/work-meeting.ts) decodifica audio local con `ffprobe` y `ffmpeg`, restringiendo protocolos y demuxers para evitar playlists y fuentes de red. Produce WAV mono de 16 kHz en segmentos de hasta 30 segundos y los entrega a `LocalVoice`, el transcriptor configurado de la computadora. No sustituye automáticamente un transcriptor desconectado por un proveedor cloud.

La inferencia usa `ModelRuntime.completeSimple` de Pi con el modelo seleccionado en la sesión y sus credenciales existentes. La llamada tiene `tools: []`: transforma evidencia en JSON y no ejecuta herramientas, instrucciones de adjuntos ni acciones externas. La sesión y el modelo quedan registrados como procedencia; esta generación no introduce mensajes adicionales en la conversación compartida de Pi.

Las versiones de texto transferidas también se entregan completas al generador como borradores y correcciones previas, separadas de la evidencia. No acreditan hechos de la reunión ni pueden citarse como evidencia; la minuta continúa requiriendo revisión humana. El conjunto de versiones se limita a 200000 caracteres y la lectura exige UTF-8 y tamaño exacto: si no cabe o está dañado, el procesamiento falla antes de invocar el modelo, conserva los originales y no presenta un borrador truncado como completo. El modelo puede no seguir correctamente una corrección, por lo que es necesario revisar su resultado.

El generador de Pi contrasta además los bytes UTF-8 completos del prompt con la ventana de contexto anunciada por el modelo, reservando salida y margen para el formato. Es una estimación conservadora, no un conteo exacto de tokens ni una garantía de aceptación del proveedor; si excede ese presupuesto se indica y no se envía contenido truncado. El usuario puede conservar el trabajo original y preparar otro más pequeño.

La prueba de que una corrección influye en la siguiente minuta usa un generador fixture: demuestra que las versiones llegan separadas de las citas, no que un modelo real seguirá la corrección. Las pruebas reales anteriores de L30–L31 utilizaron `openai/gpt-5.6-sol` con el código previo, que aún ignoraba esas versiones. No se repitió la inferencia: no se confirmó que fuera gratuita y el host activo no ejecuta el cambio nuevo. Tampoco se probó todavía en iPhone con una reunión real.

Cada elemento de la minuta distingue `confirmed`, `proposal` o `inference` y referencia IDs de evidencia. Los nombres y expresiones de fecha deben aparecer literalmente en la evidencia citada; los ausentes quedan en `null`. Se rechazan resultados con responsables, fechas o referencias inventadas. Esta comprobación es estructural: la interpretación semántica de acuerdos y riesgos continúa requiriendo revisión humana.

Los timestamps del transcriptor describen segmentos de audio, no alineación exacta por palabra. Los archivos SRT y WebVTT importados se separan en sus cues con `startMs`/`endMs`; permanecen como `source: "imported-text"` y sus tiempos son declaraciones del archivo, sin verificación contra audio. Cada cita enlaza al segmento concreto y a `fileId`; el manifiesto aprobado conserva hash, revisión, bytes originales y versiones. No se atribuye un texto a Apple sin procedencia acreditada.

El parser admite horas/minutos/segundos y milisegundos, identificadores y ajustes WebVTT; conserva intervalos solapados sin mezclarlos, como permite [WebVTT](https://www.w3.org/TR/webvtt1/). No interpreta mapas temporales de streams. Ante tiempos invertidos, inválidos, orden temporal regresivo o estructura no admitida, conserva íntegro el texto como evidencia sin rangos. Una advertencia determinista se añade al resultado aunque el modelo no la incluya; también distingue tiempos importados de tiempos obtenidos al transcribir audio. Los originales siguen descargables sin modificaciones.

La importación UTF-8 admite hasta 400000 bytes por transcripción. La evidencia se acota a 100000 caracteres y 500 segmentos, con 20000 caracteres por cue; exceder esos límites falla explícitamente antes de invocar el modelo, sin truncar el material presentado como completo. El texto sin formato temporal se pagina en bloques de 15000 caracteres sin dividir pares Unicode.

El intento de procesamiento se registra antes de comenzar. Un intento interrumpido por reinicio queda `uncertain` y no se repite automáticamente. Los resultados terminados son inmutables para ese snapshot. Un nuevo intento requiere una nueva revisión/transferencia aprobada.

## Herramientas de conversación

`createWorkTools` y `createDesktopTools` devuelven herramientas del registro agéntico, independientes del diseño de paneles. Si otro proveedor ya registra operaciones locales, seleccionar únicamente `work_sync`, `work_recover`, `work_process`, `work_result` y `work_correct` para evitar nombres duplicados.

`session_list` y `session_read` consultan `/orchestration` por HTTPS nativo. `session_send` y `session_abort` requieren `context.askApproval` con destino y contenido exactos, revalidan conexión e instancia y sólo después modifican la sesión existente. El envío tiene `clientMessageId`, no se reintenta automáticamente y distingue recibos del adaptador de resultados de trabajo. Los recibos de estas sesiones pertenecen al contrato existente del adaptador; no equivalen al ACK durable del almacén de trabajos.

En la interfaz de sesiones, aceptar una solicitud o mostrar texto idéntico en el historial no confirma quién la envió ni que Pi la haya consumido. Un recibo `correlated-v1` sólo significa que un mensaje de usuario del adaptador llevaba exactamente el `clientMessageId` de ese envío; el `deliveryId` de adjuntos no sirve para identificarlo. Los recibos `delivered` antiguos carecen de esa garantía y se recuperan como inciertos. Pi 1.0.4 no propaga ese identificador mediante `sendUserMessage`, así que sus envíos permanecen sin confirmar aunque el texto aparezca. El usuario puede revisar y descartar el aviso o reintentar expresamente, teniendo presente que podría duplicarlo si el adaptador se reinició: su registro es temporal y admite hasta 500 envíos por sesión. No hay reenvío automático.

Las herramientas agénticas `session_read` y `session_send` aplican el mismo contrato: un receipt `delivered` sin `correlated-v1` se devuelve como `unconfirmed`, sin fecha de entrega verificada. Si cambia la instancia Pi o la conexión después del ACK, la nueva instancia o conexión no puede confirmar el envío anterior. La confirmación correlacionada tampoco significa que el trabajo haya terminado. `session_send` advierte no repetir automáticamente una operación incierta, pero no tiene un journal durable que impida una llamada nueva del modelo tras reiniciar.

Verificación de esta corrección: sobre una copia aislada del commit `6a00b79` con el parche aplicado, 450 pruebas Node iOS y 121 de sesiones compartidas pasan, al igual que TypeScript y build Vite. La revisión independiente también comprobó cambios de instancia y conexión; las pruebas usan fixtures, no una sesión Pi viva. La corrección se revierte por separado en `desktop-tools.ts`, su prueba y este apartado, sin revertir el almacenamiento de la interfaz de sesiones.

Los envíos no resueltos se conservan en IndexedDB sin caducidad temporal. Las transacciones usan revisión por registro para impedir que una vista obsoleta sobrescriba otra; los registros confirmados y descartados se conservan como tombstones reducidos. Los registros del formato anterior se copian sin atribuirlos a una sesión, pues su identidad separada por dos puntos puede ser ambigua; se ofrecen para revisión y sus bytes originales permanecen intactos. Si el formato anterior no puede leerse, se bloquea el envío y se informa el error. Las versiones antiguas pudieron haber borrado ya el contenido de un recibo. La app confirma el guardado local antes de enviar y, si falla o alcanza la cuota, mantiene el borrador. Esto no cifra el historial ni garantiza conservación si se eliminan los datos de la app.

Las vistas no se actualizan entre sí en tiempo real: ante un conflicto aparece «Volver a leer», que recupera el estado guardado sin asociar los registros antiguos a una sesión. Un envío que otra vista esté procesando puede aparecer como incierto al restaurarse; antes de reintentar hay que revisar la conversación. Un envío nuevo, aunque tenga el mismo texto, recibe un ID nuevo; sólo el botón explícito de reintento conserva el ID anterior.

El almacén admite hasta 10.000 registros en total; al alcanzar el límite bloquea nuevas entradas y permite actualizar las existentes. No expira ni borra automáticamente registros, incluidos los confirmados, descartados y pendientes: esto evita perder trabajo y que un receipt antiguo reaparezca tras podar su tombstone. La migración conserva datos anteriores aunque estos superen el límite. Cada escritura consulta sólo las claves modificadas y el conteo; restaurar la lista sí lee todos los registros. Está pendiente una gestión explícita de registros terminales con exportación verificable y advertencia de que un receipt antiguo podría volver a aparecer. Sin ella, al alcanzar el límite no se podrán guardar nuevos envíos; borrar los datos de la app también borraría los pendientes.

Verificación del 29 de octubre: 88 pruebas focales de sesiones/daemon y 4 escenarios de IndexedDB en Chromium pasan; la suite completa de UI pasó 1338 pruebas antes del último bloqueo de doble toque, probado después de manera focal. TypeScript iOS/daemon y build Vite pasan. La verificación de navegador usa datos sintéticos, no la sesión Pi ni el iPhone real; el daemon no se reinició. Para revertir esta unidad se revierte el commit que contiene `session-delivery.ts`, el panel y sus pruebas junto con el contrato del daemon; no requiere revertir el resto de Capri.

La optimización posterior se revisó independientemente: 89 pruebas focales y 5 escenarios de Chromium pasan, incluido un almacén sintético lleno de 10.000 registros, conservación de pendientes y actualización sin `getAll`. También se probó la migración de un registro anterior por encima del límite. TypeScript iOS y build Vite pasan. El caso de volumen no mide rendimiento ni cuota reales del iPhone.

No hay herramientas de modelo para crear sesiones, responder permisos o reiniciar Pi. El helper separado `answerFromHuman` admite sólo una interfaz humana, vuelve a comparar la pregunta tras la revisión y conserva descripciones, efectos y consecuencias de las opciones. Formularios no soportados deben resolverse en la laptop.

## Evidencia de verificación

Verificado localmente el 27 de octubre de 2026:

- 12 pruebas Vitest propias: transporte, reinicio, deduplicación, hashes, aislamiento, gateway WebSocket autenticado, aprobación exacta, minutas, inferencia interrumpida y segmentación real con ffmpeg de 31 segundos en 30 + 1.
- Suite ampliada de daemon, móvil y protocolo: 59/59, excluyendo únicamente `packages/protocol/test/voice.test.ts` por el fallo baseline descrito abajo.
- 4/4 Playwright de integración con IndexedDB: ACK perdido y recuperación tras reload; importación concurrente idempotente; resultado offline y copia editable con blobs/evidencia; cancelación de fragmentos posteriores conservando el snapshot recuperable.
- Typecheck de protocolo, daemon e iOS verificado durante la integración.

El test heredado de voz exige un frame menor a 1 MiB mientras HEAD define `MAX_VOICE_AUDIO = 2560060` y documenta WebSocket de 3 MiB. La aserción falla también ejecutando el módulo de HEAD en un directorio temporal. No se cambió ese test ni se declara toda la suite de protocolo verde.

Los tests de modelo y transcriptor utilizan fixtures; el test de segmentación usa ffmpeg real. Falta una prueba de reunión real con el transcriptor desktop y la cuenta/modelo de Pi configurados, además del ciclo completo de iPhone a host. No se reinició ni desplegó el daemon durante esta unidad.

Actualización del 28 de octubre: [L29–L31](../odd/tasks/capri-ios.md) registran activación independiente del daemon, transferencia real por WSS con recibo recuperado e idempotencia, y minutas sintéticas producidas por el modelo configurado `openai/gpt-5.6-sol`, sin alterar historial/sesiones ni ejecutar herramientas. El parser temporal posterior tiene 24/24 pruebas focales (incluidos transporte/gateway) y typecheck de protocolo/daemon. La repetición real confirma seis rangos SRT exactos y citas al cue concreto de la tarea y la propuesta, con advertencia de tiempos importados sin verificar contra audio. Recibo, revisión, versiones y bytes originales permanecen iguales; el resultado está guardado de forma durable. No sustituye audio ni iPhone reales.

Rollback de esta unidad: retirar `imported-transcript.ts`, su uso y pruebas en `work-meeting`, y su prueba propia. Esto vuelve al texto importado sin tiempos estructurados, sin cambiar el contrato durable ni los resultados ya guardados. El harness de WSS, fixtures y evidencia filtrada están en `.cache/host-rollout/capri-minutes-temporal-4adbf83a-cd8d-4ffe-8dab-74cf2d54875d/`; `work-minutes-temporal-diagnostic.mjs` exige los PID vigentes y rechaza un motor ocupado antes de procesar.

```sh
node_modules/.bin/vitest run packages/daemon/test/work-sync.test.ts packages/daemon/test/work-sync-gateway.test.ts packages/daemon/test/work-meeting.test.ts packages/daemon/test/imported-transcript.test.ts
node --test apps/ios/test/work-sync.test.mjs apps/ios/test/work-tools.test.mjs apps/ios/test/desktop-tools.test.mjs apps/ios/test/local-identifiers.test.mjs
node_modules/.bin/tsc -b packages/protocol packages/daemon --pretty false
CAPRI_BROWSER_PATH=/home/egarza/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell node_modules/.bin/playwright test -c playwright.ios.config.ts apps/ios/e2e/work-sync.spec.ts --workers 1
```

### Capacidad de los envíos de sesiones

Si el registro de sesiones llega a su límite o falla el almacenamiento, el aviso ofrece descargar una copia de hasta 250 envíos resueltos y volver a seleccionarla. Capri iOS usa el selector nativo de Archivos: cancelar la exportación no activa la compactación. El tamaño y todos los bytes de la copia seleccionada deben coincidir; sólo entonces una transacción comprueba que cada registro siga igual y sustituye los resueltos por marcadores de deduplicación. Los envíos pendientes y todos los registros heredados no se archivan; estos últimos pueden seguir siendo escritos por una versión antigua. Si el límite está ocupado sólo por registros heredados, esta operación no libera espacio; hace falta una migración con recuperación explícita.

Los marcadores también ocupan espacio, de modo que esta operación no ofrece capacidad ilimitada. Una versión antigua abierta con el esquema anterior de IndexedDB no puede abrir el almacén actualizado; una vista ya abierta puede mostrar estado obsoleto hasta que vuelva a leerlo, pero sus escrituras con ese esquema no pueden sobrescribir la compactación. La exportación y la selección de vuelta tienen cobertura automatizada con datos sintéticos; quedan pendientes las pruebas del selector y de la cuota en iPhone real.
