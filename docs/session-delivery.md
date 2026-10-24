# Envíos visibles y actividad de las sesiones

La conversación muestra los mensajes pendientes y la actividad de comandos mientras la sesión trabaja. La confirmación de la conexión y la recepción por la sesión aparecen como estados diferentes. Gentle Shell conserva sus herramientas, permisos y ejecución normal.

Al abrir una sesión con el adaptador actualizado, el selector **Entrega del mensaje** permite enviar en la siguiente pausa del agente (`steer`, predeterminado) o al terminar su trabajo actual (`followUp`). La primera opción usa la cola nativa de Pi; no interrumpe un comando en ejecución ni responde permisos automáticamente.

| Estado visible | Evidencia y significado |
|---|---|
| Enviando al equipo | La petición HTTP sigue pendiente; se conserva el borrador. |
| Recibido por la conexión | El adaptador aceptó la operación. Todavía no prueba que la sesión haya incorporado el mensaje. |
| En cola | El adaptador recibió la instrucción mientras la sesión estaba ocupada; espera su incorporación. |
| Recibido por la sesión | El adaptador observó un evento real de mensaje de usuario con el texto enviado. No significa que la respuesta haya terminado. |
| Sin confirmación | La petición no pudo confirmarse, o el agente lleva más de 30 segundos disponible sin cola ni evidencia de recepción. Revisa el historial antes de reenviar. |

Los adaptadores antiguos permiten mostrar el envío local y comprobar una entrada nueva de usuario que coincida exactamente en el historial. No anuncian recibos nativos ni el selector de entrega. Texto transformado por una extensión o expandido al adjuntar archivos puede quedar sin confirmación; la app no inventa una recepción.

La sesión abierta se consulta independientemente de la búsqueda de otras terminales. Se programa una lectura cada **1 segundo mientras trabaja o tiene envíos pendientes**, y cada **4 segundos cuando está disponible**, después de terminar la petición anterior. No hay lecturas simultáneas del mismo refresco; los fallos aumentan la espera hasta 15 segundos y la pestaña oculta detiene las consultas. Son intervalos de consulta, no una medición de latencia garantizada. Una acción confirmada libera el editor sin esperar a recorrer nuevamente todas las sesiones.

La vista **Comandos y herramientas** muestra el comando activo y permite desplegar los últimos comandos con su estado. Usa los datos de actividad ya publicados por el adaptador; conserva el filtrado existente de credenciales y comandos privados. No exporta razonamiento interno ni toda la salida de terminal.

Cada mensaje con recibos nativos tiene una identidad estable. Un reintento explícito del mismo contenido conserva esa identidad y el adaptador evita incorporarlo dos veces; reutilizarla con otro contenido se rechaza. La app no reenvía automáticamente mensajes con resultado incierto. Los recibos y la deduplicación viven en memoria del adaptador, con un límite de 500 identidades por sesión. Los recibos pendientes se recuperan al volver a abrir la conversación mientras siga vivo ese adaptador. No hay garantía de entrega exactamente una vez entre reinicios, cambios de sesión o recargas del adaptador, ni una cola persistente de envíos sin conexión. Los archivos conservan sus comprobaciones y restricciones de reenvío existentes.

Las sesiones de Gentle Shell que ya están abiertas conservan el adaptador que cargaron al iniciar. Para activar recibos y modos de entrega, abre una sesión nueva con el adaptador actualizado o recárgalo desde su terminal original cuando haya terminado el trabajo y no queden solicitudes pendientes. El despliegue de la app no debe recargar ni reiniciar automáticamente sesiones activas.

La verificación incluye una prueba con el motor Pi real y un modelo local simulado: una instrucción HTTP llega durante una inferencia retenida, queda en cola, se incorpora al liberar la inferencia y produce un recibo de recepción. Repetir la misma identidad no crea otra petición al modelo. Las pruebas de interfaz cubren los estados separados, recuperación de pendientes, selección de modo, conservación de borradores y pausa de consultas al ocultar la app.
