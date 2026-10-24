# Un chat continuo sin cargarlo entero

Gentle Dot conserva una conversación visible y mantiene por separado el historial, los recuerdos y las tareas activas. Cambiar de tema no cancela el trabajo delegado. El modelo tiene un límite de contexto: la continuidad se consigue guardando el estado y recuperando información cuando hace falta.

## Qué sucede en el uso diario

| Situación | Comportamiento |
| --- | --- |
| Ayer hablamos de un viaje; hoy pregunto por un proyecto | Dot atiende el proyecto con el contexto reciente. Si vuelves al viaje, puede buscar los fragmentos anteriores con fecha y origen. |
| Una sesión trabaja en una aplicación mientras converso sobre otro tema | Su objetivo y sus identificadores quedan guardados fuera del chat. Un resultado nuevo despierta la continuación correspondiente. |
| Una sesión pide un permiso que delegué explícitamente para todas sus solicitudes | Las confirmaciones operativas reconocidas pueden resolverse en el servicio, sin esperar a que el modelo quede libre ni generar una respuesta de relleno. |
| La autorización tiene condiciones o la pregunta necesita una decisión personal | Se conserva la revisión normal del alcance; Dot no inventa la respuesta. El permiso sigue disponible en Sesiones. |
| Dejo el chat abierto durante muchas horas | Se muestran bloques del historial y se renueva la caché al estar al final y en reposo. Leer mensajes anteriores no debe mover la pantalla. |

## Cuatro capas distintas

1. **Historial original en disco.** Los archivos de conversación permanecen disponibles. La interfaz pide páginas; `dot_history` busca fragmentos de la cadena de este chat sin llamar a un modelo.
2. **Contexto reciente y resúmenes.** Pi compacta según la ventana del modelo. Dot renueva el archivo activo al superar 20 MiB o 10 compactaciones. El contexto de continuidad tiene un límite de 32.000 caracteres e incluye mensajes recientes, también los posteriores al último resumen.
3. **Recuerdos duraderos.** La memoria existente conserva preferencias y hechos útiles. Dot debe recuperar los detalles relevantes y comprobar información que pueda haber cambiado; un resumen no es una copia perfecta del pasado.
4. **Objetivos, delegaciones y alertas persistentes.** Tienen estado propio, identificadores de sesión y colas de eventos. No dependen de que la orden original siga dentro de la ventana del modelo.

La búsqueda devuelve fragmentos limitados y un cursor si queda más por revisar. Una búsqueda parcial sin coincidencias no significa que el tema nunca se habló. Los fragmentos y los resúmenes son evidencia histórica: **no crean permisos nuevos**. Las autorizaciones proceden del texto humano verificado y del estado vigente de la delegación.

Si la renovación no consigue cargar y verificar su contexto, conserva o recupera la sesión anterior; no sustituye la conversación por una sesión vacía silenciosamente.

## Varias cosas en curso

Dot puede seguir objetivos en distintas sesiones mientras la persona le pide consultar el navegador o usar un conector. Cada objetivo mantiene sus sesiones, instrucciones y estado; una pregunta sobre otro tema no sustituye ese seguimiento. Las sesiones externas ejecutan su propio trabajo y las comprobaciones de eventos no requieren mantener al modelo pensando.

Las lecturas de una sesión no bloquean operaciones en otra. Las modificaciones de una misma sesión conservan su exclusión mutua y vuelven a comprobar la identidad y autorización antes de enviarse. La consulta de correo y la preparación de resultados se hacen fuera de la reserva del turno del modelo, para que una fuente lenta no retenga una continuación lista de otro objetivo.

El chat utiliza un turno de razonamiento a la vez. Esto no impide que los agentes externos sigan trabajando ni que se reciban instrucciones nuevas. Las acciones sobre un mismo navegador se ordenan: compartir una página entre dos acciones simultáneas podría hacer que un clic o una captura actúe sobre el sitio equivocado. Los conectores independientes pueden atender llamadas concurrentes; cancelar una llamada no debe desconectar las otras llamadas del mismo conector.

**Engram forma parte de la continuidad.** El complemento nativo y el conector MCP permiten guardar hechos útiles y recuperar recuerdos. Dot usa su propio proyecto para los guardados predeterminados; no hereda accidentalmente el proyecto de la terminal que lo inició. Puede buscar entre proyectos cuando el encargo lo necesita, manteniendo el origen de cada recuerdo. Las memorias no sustituyen el estado de las tareas ni conceden permisos. Las continuaciones que sólo redactan avisos conservan su restricción de no ejecutar herramientas.

## Aprobaciones en segundo plano

La ruta anterior esperaba el sondeo de sesiones, otro sondeo de continuaciones, disponibilidad del modelo, inferencia, inspección y respuesta. Ahora el descubrimiento de una solicitud consulta primero una regla local de delegación.

La regla rápida se deriva únicamente de una instrucción humana completa e inequívoca, por ejemplo «Aprueba todos los permisos de esta sesión». Está ligada a la sesión concreta y se invalida al pausar, revocar, vencer un límite explícito o cambiar la autorización. Una frase limitada como «Aprueba únicamente las pruebas locales» mantiene la revisión de alcance. Un resumen escrito por el modelo nunca activa esta regla.

Antes de responder se comprueban otra vez la sesión, el contenido completo y el identificador de la pregunta. Sólo se resuelven confirmaciones operativas booleanas reconocidas; formularios, credenciales y concesiones generales de conectores no entran en esta ruta. La operación se registra antes del envío y sólo consta como aprobada tras la confirmación del adaptador. Un resultado ambiguo se deja para revisión y no se repite automáticamente.

La vía rápida no genera un turno del modelo ni un aviso de aprobación rutinaria. El registro mantiene el contador y la fecha. Los resultados de trabajo siguen produciendo las continuaciones o los avisos que estén configurados. La detección continúa dependiendo del sondeo de la integración —normalmente cada tres segundos— y de la respuesta del canal; no se promete latencia cero.

## Pantalla y rendimiento

En PC, las opciones secundarias se agrupan en un menú. La conversación monta como máximo 120 mensajes a la vez, con navegación por bloques solapados. Los mensajes históricos estables no vuelven a procesar su Markdown con cada fragmento de una respuesta nueva.

La caché del cliente puede renovarse después de 400 mensajes cuando se está al final, en reposo y sin interacción pendiente. Se difiere mientras se lee atrás, se selecciona texto o se usa un visor. El servidor mantiene índices de posiciones en los archivos y reconstruye únicamente la página solicitada, sin guardar todas las imágenes y respuestas de herramientas en memoria.

El equipo y el servicio deben seguir encendidos para observar eventos. Esperar novedades no consume llamadas al modelo; interpretar un resultado, redactar un resumen o continuar una tarea sí puede consumirlas. El historial sigue ocupando disco: estas mejoras reducen el contexto y la carga de la interfaz, no ofrecen almacenamiento infinito.

## Fundamento y comprobación

El diseño combina compactación, notas persistentes y recuperación bajo demanda, coherente con [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Separar los pasos deterministas de la deliberación evita llamadas innecesarias en las operaciones predecibles, siguiendo la distinción entre flujos y agentes de [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

La implementación se verifica con sesiones y canales simulados: alcance y revocación de permisos, carreras y reintentos, recuperación tras compactar, lectura paginada y búsqueda confinada al historial propio. Las comprobaciones visuales cubren el panel estrecho de PC y la navegación del historial. No se usan aprobaciones de trabajo real como prueba.
