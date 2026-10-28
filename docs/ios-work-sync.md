# Trabajos durables, minutas y sesiones Pi desde Capri

Capri puede conservar trabajos y adjuntos offline, transferir una revisión aprobada al daemon con confirmación durable, recuperar un ACK perdido y preparar minutas con evidencia. Las herramientas de conversación también consultan sesiones Pi existentes y proponen instrucciones para ellas. El código de este documento no implica despliegue del daemon ni validación de inferencia en el iPhone.

## Recorrido operativo

1. Crear o importar un trabajo. `createImportedWork("share:<UUID>", input)` deduplica metadata y bytes antes de confirmar su transacción IndexedDB. La extensión Compartir debe esperar esa promesa antes de borrar su original.
2. Revisar el contenido en la conversación. `work_sync` presenta manifiesto, revisión y hashes; una aprobación corresponde únicamente a esos bytes y ese host.
3. Transferir. `begin`, `chunk` y `commit` usan el mismo `transferId`. `sent` sólo aparece después de un recibo correlacionado y durable.
4. Solicitar la minuta. `work_process` requiere una aprobación separada de esa revisión confirmada. El resultado siempre tiene `requiresReview: true`.
5. Recuperar el resultado con `work_result`. Queda en `WorkItem.result`, disponible offline. `work_correct` conserva evidencia y adjuntos en un trabajo nuevo y editable, inicialmente sin aprobación.

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
- Cuota por dispositivo: 100 transferencias y 512 MiB reservados. Cada trabajo permite 10 adjuntos originales y 100 versiones, hasta 130 MiB incluyendo texto; los límites originales de adjuntos siguen siendo 25 MiB por archivo y 50 MiB sumados.
- La eliminación local y la revocación de un dispositivo no borran automáticamente los datos del host. La gestión de retención remota requiere una unidad posterior; una nueva vinculación no hereda automáticamente el namespace anterior.

El [dispatcher iOS](../apps/ios/src/work-sync.ts) conserva un snapshot inmutable en IndexedDB antes de enviar. Los cambios de contenido invalidan la aprobación. Ante desconexión o un ACK perdido mantiene `uncertain`; recuperar consulta primero `status`. No vuelve a ejecutar procesamiento ni acciones externas por reconectar. Si el host no encuentra el snapshot, exige revisión nueva antes de otro intento.

Los hashes usan WebCrypto cuando está disponible y CryptoKit por el bridge nativo, en fragmentos, cuando WKWebView no ofrece `crypto.subtle`. Los identificadores tienen un fallback UUIDv4 basado en `getRandomValues`, sin aleatoriedad débil.

## Minutas y evidencia

El [procesador](../packages/daemon/src/work-meeting.ts) decodifica audio local con `ffprobe` y `ffmpeg`, restringiendo protocolos y demuxers para evitar playlists y fuentes de red. Produce WAV mono de 16 kHz en segmentos de hasta 30 segundos y los entrega a `LocalVoice`, el transcriptor configurado de la computadora. No sustituye automáticamente un transcriptor desconectado por un proveedor cloud.

La inferencia usa `ModelRuntime.completeSimple` de Pi con el modelo seleccionado en la sesión y sus credenciales existentes. La llamada tiene `tools: []`: transforma evidencia en JSON y no ejecuta herramientas, instrucciones de adjuntos ni acciones externas. La sesión y el modelo quedan registrados como procedencia; esta generación no introduce mensajes adicionales en la conversación compartida de Pi.

Cada elemento de la minuta distingue `confirmed`, `proposal` o `inference` y referencia IDs de evidencia. Los nombres y expresiones de fecha deben aparecer literalmente en la evidencia citada; los ausentes quedan en `null`. Se rechazan resultados con responsables, fechas o referencias inventadas. Esta comprobación es estructural: la interpretación semántica de acuerdos y riesgos continúa requiriendo revisión humana.

Los timestamps del transcriptor describen segmentos de audio, no alineación exacta por palabra. Los archivos SRT y WebVTT importados se separan en sus cues con `startMs`/`endMs`; permanecen como `source: "imported-text"` y sus tiempos son declaraciones del archivo, sin verificación contra audio. Cada cita enlaza al segmento concreto y a `fileId`; el manifiesto aprobado conserva hash, revisión, bytes originales y versiones. No se atribuye un texto a Apple sin procedencia acreditada.

El parser admite horas/minutos/segundos y milisegundos, identificadores y ajustes WebVTT; conserva intervalos solapados sin mezclarlos, como permite [WebVTT](https://www.w3.org/TR/webvtt1/). No interpreta mapas temporales de streams. Ante tiempos invertidos, inválidos, orden temporal regresivo o estructura no admitida, conserva íntegro el texto como evidencia sin rangos. Una advertencia determinista se añade al resultado aunque el modelo no la incluya; también distingue tiempos importados de tiempos obtenidos al transcribir audio. Los originales siguen descargables sin modificaciones.

La importación UTF-8 admite hasta 400000 bytes por transcripción. La evidencia se acota a 100000 caracteres y 500 segmentos, con 20000 caracteres por cue; exceder esos límites falla explícitamente antes de invocar el modelo, sin truncar el material presentado como completo. El texto sin formato temporal se pagina en bloques de 15000 caracteres sin dividir pares Unicode.

El intento de procesamiento se registra antes de comenzar. Un intento interrumpido por reinicio queda `uncertain` y no se repite automáticamente. Los resultados terminados son inmutables para ese snapshot. Un nuevo intento requiere una nueva revisión/transferencia aprobada.

## Herramientas de conversación

`createWorkTools` y `createDesktopTools` devuelven herramientas del registro agéntico, independientes del diseño de paneles. Si otro proveedor ya registra operaciones locales, seleccionar únicamente `work_sync`, `work_recover`, `work_process`, `work_result` y `work_correct` para evitar nombres duplicados.

`session_list` y `session_read` consultan `/orchestration` por HTTPS nativo. `session_send` y `session_abort` requieren `context.askApproval` con destino y contenido exactos, revalidan conexión e instancia y sólo después modifican la sesión existente. El envío tiene `clientMessageId`, no se reintenta automáticamente y distingue recibos del adaptador de resultados de trabajo. Los recibos de estas sesiones pertenecen al contrato existente del adaptador; no equivalen al ACK durable del almacén de trabajos.

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
