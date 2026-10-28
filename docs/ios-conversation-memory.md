# Archivo offline de conversación de Capri

Capri conserva una ventana visible de 120 mensajes y un archivo separado en IndexedDB. El motor local puede consultar el archivo mediante `recall_history` y `search_memory`; los resultados incluyen origen, motor, estado, fecha y referencias al texto original. No se extraen perfiles personales ni se inventan recuerdos.

## Persistencia y recuperación

`conversation-persistence.ts` captura cada mensaje antes de recortar la ventana. La cola conserva copias hasta que `conversation-archive.ts` confirma la transacción. Las escrituras son seriales; una confirmación antigua no elimina una revisión o un recibo más reciente con el mismo ID. Restaurar la app captura los 120 mensajes heredados antes de combinarlos con eventos nuevos. La reconciliación del host entrega todos los mensajes al archivo antes de recortar la vista.

Cada registro tiene una clave formada por motor, origen e ID. Los orígenes de Gentle Dot separan URL y conversación; el iPhone usa `iphone:main`. Actualizar un stream conserva su secuencia y fecha originales. Los estados pendientes e interrumpidos permanecen explícitos, y los recibos de herramientas se conservan aunque se cancele la respuesta posterior. La fecha describe el evento de conversación, no garantiza la fecha del hecho mencionado en el texto.

La cuota es de 10 000 registros y 64 MiB de contenido UTF-8, con un máximo adicional de 512 KiB por registro; IndexedDB puede rechazar antes por espacio disponible. No se borran mensajes automáticamente. Una transacción que excede la cuota se revierte entera. Ante un fallo, los envíos nuevos quedan detenidos, se conserva la cola en memoria y se intenta guardar por separado la ventana visible y el borrador. La interfaz explica que hay contenido aún no confirmado y permite reintentar o exportarlo antes de cerrar. Cerrar o perder el proceso antes de exportar no garantiza recuperar la cola que nunca pudo escribirse.

En Archivo se pueden consultar páginas anteriores, buscar texto y exportar NDJSON. La exportación distingue registros confirmados, mensajes pendientes en memoria y borrador no enviado; no borra el archivo ni confirma sincronización. Actualmente usa una descarga Blob del navegador; la entrega por compartir nativo y su verificación en el iPhone corresponden a otra unidad. IndexedDB no añade cifrado propio ni equivale a Keychain. No se incluyen objetos de conexión, credenciales, wrappers de transporte ni metadatos desconocidos. Lo escrito por el usuario en el cuerpo de una conversación sí forma parte de ella.

## Consulta y límites

La búsqueda exige todas las palabras y omite diferencias de mayúsculas y acentos. Sólo busca en cuerpos de mensajes: no indexa borradores, secretos de conexión ni resultados de herramientas. Las páginas tienen cursor vinculado a sus filtros y un límite de 1 000 registros examinados. Una página sin coincidencias puede tener `hasMore: true`; la herramienta explica que debe continuarse antes de afirmar ausencia.

`recall_history` permite abrir un `source.key` con desplazamientos del texto o un `activityIndex` y desplazamiento para recuperar un recibo exacto. Los estados y fuentes acompañan cada fragmento. Un mensaje de usuario o una respuesta interrumpida no demuestran por sí solos que se ejecutara una acción. Los recibos conservan los límites originales de las trazas; si éstas eran parciales, hay que consultar la fuente operativa.

Los IDs vivos del host y los de su historial pueden ser distintos. El archivo conserva ambos si el protocolo no aporta una identidad estable; no deduplica por texto porque dos mensajes iguales pueden ser legítimos. La ventana visible mantiene su reconciliación existente. Este archivo tampoco recupera mensajes que ya hubieran desaparecido antes de instalar la versión que lo incorpora.

## Evidencia automatizada

Las pruebas Node cubren campos permitidos, límites, fuentes, búsqueda literal, paginación de herramientas, cola antes de recortar, confirmaciones tardías, cuota, recuperación y preservación del borrador. Playwright verifica 205 mensajes a través de la aplicación real y una recarga, un trabajo local confirmado cuya respuesta se interrumpe, consulta posterior de su recibo, exportación con contenido pendiente y borrador, bloqueo y recuperación tras fallo, concurrencia, cuotas atómicas y búsqueda dispersa en 1 200 registros. El bridge de inferencia y el host son fixtures; estas pruebas no acreditan inferencia Apple ni persistencia WebKit en dispositivo.
