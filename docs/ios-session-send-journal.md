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

Sólo se permite cerrar un aviso `unconfirmed`. En nuevos envíos `dispatching`, la recuperación comprueba ID y dueño del journal nativo: únicamente el callback terminal durable permite pasarlo a incierto. `prepared`, los registros antiguos sin comprobante y los comprobantes ausentes o activos permanecen bloqueados; que falte una fila no demuestra que el envío no ocurrió, porque el almacén nativo puede perderse o restaurarse por separado. Aunque el transporte haya fallado, el host podría seguir procesando la solicitud; la advertencia lo indica y el cierre nunca asegura que el trabajo anterior terminó. No existe idempotencia durable en Pi ni deduplicación semántica: una instrucción con texto distinto se trata como distinta. La protección no sustituye revisar el historial.

El límite es de 2.000 intentos **sin resolver**, no de todos los intentos históricos. Al alcanzarlo, nuevos envíos esperan a que el usuario revise pendientes; los registros terminales se conservan. La cuota real de IndexedDB también puede agotarse y bloquear un envío antes del transporte. Falta una gestión de exportación y archivado del historial terminal. El almacenamiento no añade cifrado propio y puede desaparecer si se eliminan los datos de la app.

## Verificación

La revisión independiente examinó cancelación, cambio de host, reserva concurrente y revisión exacta. Pasaron 45 pruebas Node focales y seis pruebas Chromium en un servidor aislado, con dos vistas, recarga, callback perdido y 2.000 registros. El typecheck de iOS pasa. Son fixtures: no demuestran entrega a Pi ni comportamiento de cuota en un iPhone real. Para revertir esta unidad, se revierte el commit que contiene `desktop-session-journal.ts`, la integración de `desktop-tools.ts`, sus pruebas y esta guía; no hace falta revertir la bandeja compartida de sesiones.

## Detener y responder solicitudes de sesión

El panel del iPhone y las herramientas de sesión comparten un diario separado para `abort` y `answer`. La identidad de detener se fija por host, panel y sesión; la de una respuesta añade el ID de la pregunta y bloquea también una respuesta distinta mientras la anterior no esté confirmada. La respuesta continúa siendo una acción humana: no existe una herramienta del modelo para contestar permisos. El journal guarda el contenido de la acción, pero no el token; IndexedDB no añade cifrado propio.

La reserva antecede al transporte. Al recibir un ACK del host que corresponde a la sesión y a su instancia se registra la recepción, que no demuestra que el trabajo ya se haya detenido ni que una acción solicitada haya terminado. Tras un error o una respuesta no verificable queda `unconfirmed`; Capri puede listar el aviso con `session_control_list` y proponer su cierre con `session_control_resolve`, que muestra al usuario el contenido guardado y requiere aprobación explícita. El host todavía podría estar procesando el control; cerrarlo no verifica, cancela ni reenvía. Una reserva `prepared` o `dispatching` sin comprobante terminal verificable permanece bloqueada; una recuperación terminal exige después revisión humana y no demuestra que el host haya terminado. Como en los envíos, el límite es 2.000 pendientes y los registros históricos pueden ocupar la cuota real. Las pruebas utilizan transporte simulado y no validan iPhone ni una sesión real.

El panel compara el contenido íntegro que la persona vio con una lectura nueva antes de enviar y conserva esa revisión en el diario local. El código nuevo del daemon y la extensión Pi publican una huella SHA-256 del diálogo y comprueban esa misma huella dentro de Pi justo antes de responder; así rechazan un diálogo sustituido con el mismo ID. Esto requiere actualizar ambos componentes del host: el servicio activo aún no se ha desplegado ni reiniciado con este contrato. Cuando la laptop usa un adaptador anterior, Capri lo indica en la tarjeta; esa ruta conserva la compatibilidad sin afirmar la protección atómica. Si el adaptador no expone una instancia verificable, el panel rechaza el control en vez de atribuir su ACK a una instancia desconocida.

## Revisión desde la sesión

La vista de sesiones muestra «Avisos» cuando hay registros del host. Se puede abrir un aviso, examinar su objetivo y contenido, y cerrar el aviso sin un modelo local y sin reenviar. Los controles y envíos del agente se paginan por separado; los avisos relacionados pueden aparecer en ambas listas y se cierran mediante la revisión de sus registros exactos. El diálogo requiere un comprobante terminal antes de revisar una operación que aún figura en transporte.

El compositor del teléfono y el agente comparten una barrera por host, sesión y texto; un timeout libera la interfaz pero no libera la barrera mientras URLSession siga activo. Una respuesta positiva del host confirma recepción, pero no consumo por Pi: la instrucción continúa en revisión hasta que exista evidencia `correlated-v1` inequívoca del mismo host, sesión e instancia, o la persona cierre el aviso tras verificar. La inspección reconcilia hasta 20 recibos verificados por lectura; IDs reutilizados entre intentos no se resuelven por inferencia. La bandeja histórica anterior no contiene comprobantes nativos: sus tarjetas inciertas permanecen visibles, sin reintento ni descarte en iOS. No hay recuperación automática de esos registros heredados. Las acciones de crear, duplicar, cerrar, otorgar o revocar aún no están cubiertas por este diario de controles.
