# Revisar envíos inciertos a una sesión Pi

Capri guarda un intento local antes de enviar instrucciones propuestas por su agente a la laptop. Si el resultado queda incierto, el mismo texto para la misma sesión y host no se envía otra vez automáticamente, incluso después de reiniciar la app. Otra instrucción puede continuar con su propia revisión.

## Cómo revisar

1. Consulta el historial de la sesión en la laptop para determinar qué ocurrió. El texto idéntico en el historial no demuestra por sí solo quién lo envió.
2. Pide a Capri que consulte los envíos pendientes de la sesión. `session_delivery_list` devuelve páginas con sus IDs y extractos.
3. Si decidiste cerrar el aviso, Capri propone `session_delivery_resolve`. Revisa el host, la sesión y el texto completo en la confirmación. Aceptar sólo cierra el aviso: no verifica la entrega, cancela ni reenvía la solicitud anterior. La solicitud puede seguir en curso y cerrar el aviso permite proponer un envío nuevo.
4. Si necesitas enviar una nueva instrucción, revisa su contenido y autorízala por separado.

## Garantías y límites

La reserva se confirma en IndexedDB antes de iniciar el transporte y usa un ID de mensaje y un dueño locales independientes. La identidad de la operación comprende host, panel, sesión y texto exacto; cambiar el modo de entrega no evita el bloqueo. El token no se guarda en este registro. La aprobación cubre el destino, texto, modo e ID exactos, y la instancia de Pi se vuelve a comprobar antes de enviar.

Una cancelación conocida antes de iniciar el transporte cierra la reserva sin llamar a Pi. Una interrupción después de iniciar el transporte conserva el intento sin confirmar. Si la confirmación del almacenamiento se pierde y no se puede cerrar la reserva, se conserva para revisión, aunque la llamada no haya comenzado. Sólo un recibo `correlated-v1` para el ID y la instancia originales permite registrar una entrega; no demuestra que el trabajo haya terminado.

La revisión humana puede cerrar un aviso mientras otra ventana todavía espera una respuesta. La advertencia lo indica y el cierre nunca asegura que el trabajo anterior terminó. No existe idempotencia durable en Pi ni deduplicación semántica: una instrucción con texto distinto se trata como distinta. La protección no sustituye revisar el historial.

El límite es de 2.000 intentos **sin resolver**, no de todos los intentos históricos. Al alcanzarlo, nuevos envíos esperan a que el usuario revise pendientes; los registros terminales se conservan. La cuota real de IndexedDB también puede agotarse y bloquear un envío antes del transporte. Falta una gestión de exportación y archivado del historial terminal. El almacenamiento no añade cifrado propio y puede desaparecer si se eliminan los datos de la app.

## Verificación

La revisión independiente examinó cancelación, cambio de host, reserva concurrente y revisión exacta. Pasaron 45 pruebas Node focales y seis pruebas Chromium en un servidor aislado, con dos vistas, recarga, callback perdido y 2.000 registros. El typecheck de iOS pasa. Son fixtures: no demuestran entrega a Pi ni comportamiento de cuota en un iPhone real. Para revertir esta unidad, se revierte el commit que contiene `desktop-session-journal.ts`, la integración de `desktop-tools.ts`, sus pruebas y esta guía; no hace falta revertir la bandeja compartida de sesiones.
