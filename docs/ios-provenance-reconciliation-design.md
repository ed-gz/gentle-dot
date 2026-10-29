# Diseño pendiente: revisión de procedencia del historial

Este documento describe trabajo pendiente. Capri todavía no aplica esta reconciliación; no se han validado la resolución humana, el downgrade ni la contención entre vistas. El problema y el límite de la recuperación de páginas están descritos en `ios-history-recovery.md`.

## Invariante y evidencia

Una advertencia de rama no verificada es una propiedad conservadora de la identidad exacta `(motor, origen de host y conversación, id)`. Revisarla no demuestra que la rama sea correcta. Una copia antigua sin la marca y una copia nueva con la marca son evidencias separadas; ninguna se reemplaza automáticamente con el contenido de la otra. El texto privado de transporte no se incluye en la vista o exportación pública.

La solución debe conservar una advertencia durable independiente de la copia de rescate. En la misma transacción IndexedDB que guarda una copia, cualquier entrada marcada añade una advertencia por identidad. Descartar una copia conserva esa advertencia y no implica aprobar ni fusionar su contenido. Para copias guardadas antes de esta función, el primer arranque debe construir las advertencias dentro de una transacción cercada, conservando las copias; datos inválidos deben producir una recuperación explícita, no descartarse.

## Lecturas, reservas y voz

La advertencia durable se superpone de manera conservadora al presentar una entrada, consultar el archivo, buscar, construir contexto del modelo, paginar o reconciliar una respuesta. Debe conservarse en exportaciones que representan el mensaje. Una lectura de conversación y sus advertencias debe obtenerlas en una transacción coherente del almacén de conversación; las lecturas del archivo requieren además revalidación porque el archivo vive en otro IndexedDB.

No se puede alterar el snapshot de una reserva con entrega de voz ni recalcular su huella como atajo. La recuperación puede confirmar el snapshot original únicamente si sus proyecciones posteriores aplican la advertencia conservada. Si se decide cambiar un registro archivado o una reserva, debe existir una intención durable con las versiones exactas observadas, pasos idempotentes, comparaciones CAS y recuperación después de cada posible corte. Los conflictos con cambios concurrentes dejan la intención y las evidencias disponibles para revisión.

Entre ventanas, la confirmación de una advertencia debe notificarse a las demás vistas; estas deben invalidar cualquier proyección en memoria y releer antes de usarla para enviar contexto o efectuar acciones. Una notificación por sí sola no es evidencia durable y puede perderse si la ventana termina. La implementación debe definir un contador o revisión durable y comprobarlo en cada frontera de uso. Una vista pasiva puede quedar desactualizada entre el commit en otra ventana y la recepción del aviso: debe establecerse explícitamente cómo se informa o se oculta durante esa ventana y probar ese comportamiento, sin afirmar una atomicidad inexistente entre IndexedDB y la pantalla.

## Revisión humana

La vista debe mostrar la identidad, las versiones disponibles y sus marcas, permitiendo exportarlas sin exponer el contexto privado de transporte. Una acción explícita puede registrar que la persona examinó esas versiones exactas y decidió continuar manteniendo la advertencia. La revisión no cambia la marca a verificada, no fusiona el texto y no envía acciones externas. Si cualquiera de las versiones cambia antes de registrar la decisión, el registro se rechaza y se solicita volver a revisar.

La persona debe poder continuar usando la conversación con la advertencia visible y las copias conservadas. Si se ofrece elegir o aplicar contenido, esa operación es separada: muestra la diferencia, exige confirmación del contenido exacto y utiliza una intención durable y CAS. Siempre conserva evidencia de la decisión y permite recuperarse de un corte; no debe depender de inferencia de IA. El descarte explícito de una copia no elimina la advertencia independiente ni las evidencias mínimas de la decisión.

## Casos que deben pasar antes de integrarlo

- Reserva con y sin voz, tanto antes como después de un archivo parcial; interrupción entre cada paso y reanudación idempotente sin alterar la huella o duplicar entradas.
- Copia marcada creada durante la restauración, durante un guardado en otra ventana y justo antes del uso por el modelo; la siguiente acción no consume una proyección anterior sin marca.
- Cambios simultáneos de texto, rol, origen, id, revisión o copia entre mostrar y confirmar; cada conflicto exige revisión nueva.
- Descarte y guardados posteriores conservan la advertencia; las copias antiguas se migran sin pérdida y las de otro host no bloquean la identidad actual.
- Todas las rutas de lectura, búsqueda, exportación, paginación e historial del host mantienen la advertencia; límites de cuota y errores no producen éxito supuesto.
- Pruebas en WKWebView/iPhone además de pruebas con Chromium e IndexedDB aislados; no se requiere un daemon activo para las pruebas destructivas de fallos.

## Fronteras actuales a adaptar

El overlay no puede limitarse a la pantalla de chat. La implementación debe cubrir al menos `conversationArchive.restoreState` y `lookupPage` en `main.ts`, paginación, búsqueda y exportación de `memory-view.ts`, resultados entregados por `conversation-memory-tools.ts`, y los constructores de contexto en `conversation.ts`. Las vistas de copias y reservas también deben conservar la marca en sus exportaciones. Los verificadores internos de archivo y huellas deben seguir comparando los bytes durables originales: una proyección para el usuario no debe hacer que una verificación exacta apruebe un contenido distinto.

El ciclo de vida de una advertencia también debe definir su resolución mediante evidencia del host. `reconcileHostHistory` ya distingue un historial con `branchVerified`; la nueva marca no debe borrarse sólo por la revisión humana ni por recibir un mensaje con el mismo texto. Antes de implementar una limpieza, precisar qué respuesta autenticada demuestra la pertenencia de esa identidad y de qué revisión de la conversación; registrar esa evidencia y usar CAS para impedir que una confirmación antigua borre una advertencia más reciente. Mientras ese contrato no esté probado, mantener la marca conservadora no debe impedir continuar conversando.

La migración y la cuota necesitan límites explícitos: pueden existir hasta 100 copias con muchos mensajes. Si no caben las marcas o no puede verificarse una copia, el sistema debe conservar los originales, comunicar el problema y ofrecer exportación; no debe marcar la migración como terminada. Si se fragmenta en lotes, el punto de reanudación y la cobertura de cada copia deben ser durables y comprobados antes de permitir que una lectura se presente como cubierta. Los contadores de revisión deben ser seguros ante desbordamiento y las escrituras de marca y copia deben fallar juntas.

La marca debe registrarse en cada frontera que recibe una advertencia, no sólo al guardar rescates: respuesta o página del host, restauración de reservas y escritura de mensajes marcados. Una observación todavía en memoria no es durable; si el almacenamiento falla, debe conservarse en la vista abierta y mostrarse como no guardada. Las pruebas deben incluir el cierre entre recepción y confirmación, sin afirmar que un evento nunca persistido pueda recuperarse después de terminar el proceso.

El scope existente combina URL del host, conversación e id; no es una identidad criptográfica del servidor ni de su instancia. Dos hosts que reutilicen esos valores pueden compartir identidad aparente. El diseño no debe afirmar aislamiento entre ellos sin un protocolo de identidad de instancia verificable.

Durante la restauración, los eventos del socket deben conservarse o cercarse hasta cargar la cobertura de marcas, sin aplicar una proyección anterior a la conversación. La invalidación entre ventanas afecta también búsqueda y contexto, no sólo el chat. Las pruebas deben forzar pérdida de notificaciones, una revisión o versión falsificada, y el arranque de una versión anterior que no conozca las marcas; ese downgrade requiere una estrategia explícita para no presentar datos sin advertencia. Si la migración o la cuota impiden comprobar la cobertura, la interfaz necesita una vía de gestión y exportación que conserve los datos.
