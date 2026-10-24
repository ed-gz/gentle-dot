# Capri en Gentle Dot

La versión móvil 0.20.8 incluye una Capri que elige sus propias formas, escenas y visitas de Rebecca. El interruptor **Gentle Dot / Capri**, en Ajustes, cambia la apariencia y la personalidad del asistente principal desde su siguiente turno. Las sesiones externas conservan su identidad, instrucciones y permisos.

## Usarlo

1. Instala la APK actualizada sobre la anterior para conservar la vinculación.
2. Activa **Modo Capri** en **Ajustes → Capri**. El modo se confirma con el equipo antes de mostrarse como guardado.
3. Déjala acompañarte. Toca o haz clic en Capri para apartarla, fijarla aquí u ocultarla. En Ajustes puedes ocultarla o cambiar los colores de la app.

El modo del asistente se guarda en el equipo. El movimiento, visibilidad, colores y posición se guardan en cada dispositivo. Las antiguas preferencias de pose, forma y compañía se migran a selección automática. Al reconectar o volver a la app se consulta el modo del equipo. Cambiar a Gentle Dot restaura la identidad anterior sin borrar conversaciones ni preferencias.

## Qué hace el personaje

En el celular y el navegador, Capri flota sobre toda la interfaz de Gentle Dot, incluidos los diálogos. Vive en una capa independiente de las vistas: pasar entre Dot, Sesiones y Ajustes conserva el personaje, su posición y su ciclo. No reserva altura ni reduce el espacio de lectura. Arrástrala con el dedo o el ratón para colocarla donde te resulte cómoda. Con el foco en la burbuja, las flechas permiten moverla; **Hazte a un lado** la cambia al otro borde. Su posición se limita al área visible, evita el compositor y se reajusta al abrir el teclado. Al abrir una pregunta busca un margen libre; si falta espacio, se hace pequeña y muestra los ojos junto al borde, sin bocadillo. Al cerrar el diálogo recupera su posición anterior. En estos dispositivos permanece dentro de la app. En Ajustes, **Área donde puede estar** delimita el rectángulo permitido; el personaje completo se mantiene dentro incluso al girar la pantalla. **Fija aquí** conserva su sitio sin congelar sus reacciones.

Saluda al aparecer, mira hacia la escritura, se acomoda al leer sesiones y señala preguntas pendientes. La boca se anima cuando la voz del chat está hablando. El movimiento automático se pausa al colocar el cursor o el foco sobre Capri, durante la interacción táctil o el arrastre, al ocultar la app y al activar la preferencia del sistema de reducir movimiento. También puedes pausarlo desde sus controles; moverla manualmente sigue siendo una acción tuya.

La reacción al escribir observa eventos locales: no lee ni transmite el borrador. En móvil no añade acceso a otras aplicaciones, pantalla o micrófono. En Linux usa el estado de reproducción MPRIS y los avisos que Quickshell entrega al puente local; no captura la pantalla ni lee borradores para elegir una reacción. Usa los mismos controles de autorización del asistente.

Hay **27 animaciones con 162 cuadros**. Las acciones principales usan secuencias de dibujos consecutivos, con tiempos propios para cada cuadro: respirar y parpadear, caminar, saludar, teclear, tomar café, acomodarse en el sillón, llorar y enojarse. Las escenas compartidas tienen sus propias secuencias. También hay ciclos de palomitas, estirarse, curiosidad, atención, ojos, rostro y dedos apuntando a ambos lados. El reloj vive sólo en el sprite; no vuelve a dibujar el chat en cada cuadro ni solicita imágenes a un servidor. El paseo termina su ciclo al llegar y vuelve a la acción del momento. Al pausar se conserva el cuadro actual. El acceso circular del perfil conserva su ilustración fija.

Hay **47 poses y escenas**, incluidas las acciones de archivar un documento, sentarse en un borde y hacerse a un lado. Incluyen Capri llorando, trabajando, estresada, enojada, con una tazota de café, descansando, estirándose y comiendo botana; Rebecca sola y ambas viendo sesiones, compartiendo café, riendo, revisando una laptop y descansando en el sillón.

Capri alterna cuerpo, rostro y ojos según la actividad. Los gestos de manos quedan fuera de la rotación espontánea: no se muestran sin un elemento concreto que señalar. Al escribir alterna teclear contigo, observar y asomarse; al leer puede observar, tomar café o descansar. Las visitas empiezan con Capri invitando a Rebecca y siguen con escenas compartidas. No hay galería ni selectores de poses o compañía. Las expresiones ilustran la actividad del asistente; no implican detectar emociones del usuario.

Los ciclos se detienen al pausar animaciones, reducir movimiento en el sistema u ocultar la app. Fijar la posición, colocar el cursor o darle foco sólo detiene el desplazamiento: sus gestos y escenas continúan. Las preguntas pendientes y una pérdida de conexión tienen prioridad sobre las escenas decorativas.

**Colores y animación → Colores de la app** cambia inmediatamente entre Capri original, Hacker (verde), Afterlife (violeta) y Atardecer (ámbar). Para cambiar los colores de una terminal real, abre **Ambiente de terminal** en esa sesión. Es una operación independiente: cambiar sólo la app no recolorea terminales. Consulta [los ambientes de terminal](terminal-moods.md) para las ventanas compatibles y la restauración.

Las secuencias nuevas están en `packages/ui/src/assets/capri/capri-motion-*-v1.png`, con manifiestos de cuadros y duración. Los atlas originales se conservan para el acceso fijo y la recuperación si falla la carga. Las escenas de descanso alternan ciclos. Las acciones ligadas a un evento, como guardar un documento o hacerse a un lado, se reproducen una vez y conservan su último cuadro hasta terminar el evento; no repiten la misma operación continuamente.

El arte está en `packages/ui/src/assets/capri/`: `capri-atlas-v2.png`, `reactions-atlas-v1.png` y `friends-atlas-v2.png`. Rebecca se rehízo usando la guía oficial de CD PROJEKT RED: frente despejada, coletas menta, ojos coral/lima/magenta y manos cibernéticas azul y rosa. Sus manifiestos JSON contienen rectángulos y polígonos medidos que evitan mostrar piezas vecinas. No se debe suponer una cuadrícula uniforme. Los archivos `generation-prompts*.txt` conservan los prompts y la validación de las generaciones con imagegen.

## Capri sobre el escritorio de PC

En la app de escritorio, abre **Opciones → Settings → Capri**. También puedes activarla desde el menú de la bandeja. Este interruptor pertenece a ese equipo: no cambia el modo ni la personalidad elegida en el celular o en el chat.

Al activarlo, Capri sustituye la flor y aparece en una ventana transparente sobre las aplicaciones. Pasea, cambia de pose y recibe visitas de Rebecca. Puedes arrastrarla o moverla con las flechas cuando tenga el foco; un clic abre la conversación. El rostro fijo aparece únicamente mientras Capri está escondida, para mantener el acceso al chat sin duplicar personajes. La aparición y el movimiento automáticos no solicitan el foco del teclado.

En Hyprland, el personaje que pasea desactiva el desenfoque, sombra, borde y redondeo de su propia ventana mediante una regla temporal con identidad privada. Conserva la transparencia del sprite y evita el recuadro de vidrio que el compositor puede añadir incluso cuando WebKit entrega píxeles transparentes. Desactivar Capri retira esa regla y recupera el aspecto previo. El botón circular del perfil conserva su fondo y estilo.

Elige **Libre** o **Fija aquí**. Fijarla guarda su posición entre reinicios y conserva los gestos; todavía puedes arrastrarla para cambiar su sitio. En **Pantallas y espacio** elige qué monitores permite usar y ajusta un rectángulo en cada uno, arrastrando, con teclado o con las zonas rápidas. Los monitores excluidos nunca son destinos automáticos; si desconectas la única pantalla permitida, Capri se oculta hasta que haya una zona disponible. El clic derecho sobre Capri abre Fijar aquí, Ocultar y Configurar Capri. **Traer a Capri** respeta el área permitida. El paseo se pausa al acercar el cursor, al usar sus controles, con movimiento reducido y durante el control del equipo. Desactivar el modo de escritorio restaura la flor y su preferencia anterior de visibilidad.

Esta implementación nativa requiere **Linux con Hyprland y configuración Lua**. Los equipos no compatibles muestran el motivo en el control. La activación se guarda por separado en `~/.gentle-dot/desktop-companion.json`. El acceso fijo no mantiene otra conexión ni carga el historial. Las ventanas de Capri se apartan de las capturas y operaciones del control del equipo, igual que la flor original.

## Actualización de sesiones y avisos

La actualización de Dot no recarga las extensiones de un Gentle Shell que ya esté abierto. Los recibos nativos de entrega y adaptadores nuevos están disponibles en sesiones nuevas. Para actualizar una sesión existente, escribe `/reload` en su terminal cuando haya terminado su trabajo y no tenga preguntas, mensajes pendientes, subagentes ni monitores que necesites conservar: recarga todas sus extensiones y puede cancelar trabajos auxiliares. La conversación se conserva. La interfaz evita presentar una aceptación del servidor como recepción confirmada por la IA.

En este equipo también quedó instalado el puente de las tres decisiones de revisión de Gentle Shell, con los archivos originales respaldados junto a sus fuentes con el sufijo `.before-gentle-dot-review-bridge`. Entrará en uso al iniciar una sesión nueva o recargarla; no se recargaron las ocho sesiones abiertas durante la actualización.

Los avisos Android usan el servicio de conexión con tu equipo y Tailscale. Necesitan conexión, permisos de notificación y el monitoreo activado. El servicio puede recuperar su configuración cifrada si Android lo recrea; no promete entrega mientras el teléfono esté sin red ni después de forzar la detención de la app. La recepción con pantalla apagada requiere validación en el teléfono físico.

## Verificación

Las pruebas cubren la selección confirmada del modo, migración a comportamiento automático, cambio de equipo durante una petición y preferencias sin almacenamiento. Las pruebas de navegador verifican arrastre táctil, controles mínimos, minimizar y restaurar, clics fuera del personaje, diálogos nativos con interacción real, navegación sin remontar a Capri, teclado, 375 px, horizontal, pantalla grande, movimiento reducido y texto al 200 %. Los sprites son ilustraciones prerenderizadas; no consumen llamadas a un modelo para animarse. Falta validar esta actualización en el teléfono físico.

La versión de escritorio tiene pruebas de preferencias independientes, respuestas tardías, errores de activación, pausas y acceso fijo sin conexión adicional. Se revisaron las poses a tamaño real de 156 px y el acceso de 56 px. Las pruebas aisladas de Hyprland y GTK cubren foco, movimiento y transparencia.

La distribución anterior se compiló sin `custom-protocol`: sus ventanas intentaban abrir el servidor de desarrollo en `127.0.0.1:5173`. Las comprobaciones de geometría no detectaron que el contenido era una página de error. Ahora el contrato de compilación rechaza una distribución sin recursos embebidos. Una prueba nativa de WebKit verifica que React y los sprites cargan desde `tauri://localhost` sin Vite, que la interfaz sigue abierta sin daemon y que se reconecta tras reiniciarlo.

La APK 0.20.3 conserva la firma de 0.20.2 y contiene los 119 archivos web exactos de la compilación nueva, incluidos los tres atlas de animaciones y Rebecca corregida. Se validaron 699 pruebas de interfaz entre la suite completa y una repetición seriada de seis esperas que agotaron su tiempo bajo carga, sin cambios en los tests ni en sus tiempos. También pasaron 48 pruebas Android, cero errores de Lint y ocho casos completos de navegador móvil. La descarga HTTPS se comparó por SHA-256 con el paquete construido. La suite Rust pasó 482 pruebas y la prueba optativa de WebKit cubrió también un `connection_info` demorado antes del arranque del daemon. El chequeo de contenido instalado exige los marcadores nativos de montaje y decodificación de recursos de cada ventana; la salud del servidor por sí sola no cuenta como validación visual. Una prueba adicional del compositor compara un fondo opaco propio antes y después de superponer una ventana transparente: reproduce el vidrio anterior, verifica su eliminación y restaura exactamente las propiedades previas. No captura otras aplicaciones.

La prueba móvil compara capturas reales de cuadros distintos y verifica que se conserva la misma imagen al reducir movimiento. La prueba nativa de WebKit comprueba cambio de cuadro, recorte y desplazamiento dentro del atlas con un encuadre fijo; detectó 11 997 píxeles distintos entre los dos cuadros de caminata y confirmó que el evento nativo de llegada termina la caminata. La animación se detiene al ocultar la app y al reducir movimiento; fijarla o interactuar conserva sus gestos. Los prompts originales y la procedencia de los PNG sin modificaciones están en `generation-prompts-v5-animation.txt`.


### Ajustes de espacio en 0.20.4

**Libre / Fija aquí** controla la posición sin congelar los gestos. En el teléfono, **Área donde puede estar** guarda una zona local y ofrece arrastre, redimensionado, teclado y zonas rápidas. En PC, el mapa usa las pantallas conectadas; cada una tiene permiso y zona propios. Los monitores que se conecten después de guardar una selección explícita quedan excluidos hasta habilitarlos. Si una zona no tiene espacio suficiente, Capri se oculta y el acceso circular permite entrar a Ajustes.

Los controles de escritorio están dentro de Settings y en el menú contextual de Capri; la barra «Acompañante» se retiró del chat. El acceso circular conserva su estilo y sólo es visible mientras el personaje está oculto. Las manos sueltas ya no aparecen durante la rotación espontánea.

Esta versión añade ocho ciclos de seis cuadros. La prueba nativa compara píxeles reales mientras Capri está fijada y bajo el cursor, y comprueba la visibilidad alternada de las ventanas GTK. Las pruebas de navegador móvil cubren fijación viva, zona persistente, arrastre durante el paseo, modales, teclado, orientación y texto al 200 %. El pin durante una pregunta también conserva su posición de retorno. La APK firmada conserva la identidad de la versión anterior, incluye cinco atlas animados y los 121 recursos web exactos; pasan 48 pruebas Android, sin errores de Lint. Sigue pendiente la comprobación en un teléfono físico.


### Reacciones al contexto en 0.20.5

En Linux, una reproducción activa por MPRIS activa audífonos o baile. Pausar el reproductor elimina esa señal. Las preguntas nuevas, la escritura y el trabajo de la sesión tienen prioridad; el descanso conserva variación. Los ciclos nuevos están en `capri-motion-context-v1.png` y su manifiesto, generados con imagegen y transparencia real. Los prompts y la procedencia están en `generation-prompts-v7-context.txt`.

Capri recibe actividad de la sesión enfocada y preguntas pendientes desde un endpoint pequeño que reutiliza la caché del orquestador. Una pregunta se anuncia durante ocho segundos y permite seleccionar la sesión en Herdr cuando existe una conexión verificada. El clic selecciona el panel de Herdr; no trae la ventana del terminal al frente ni responde la pregunta. El mismo aviso no se repite continuamente y el personaje puede volver a acompañar la escritura o la música.

El puente de `GentlePromptEditor` observa el hecho de editar, enviar o iniciar una respuesta, sin leer ni guardar el borrador. Está preparado para sesiones nuevas o para la siguiente construcción del editor. Una sesión ya abierta conserva su implementación hasta una recarga segura. Sólo la sesión enfocada con esta capacidad recibe la consulta rápida de actividad; se detiene cuando no hay un consumidor de Capri. Las versiones anteriores siguen funcionando sin enviarles un método desconocido.

El protocolo de Herdr expone foco y celdas de terminal, pero por sí solo no ofrece el origen exacto de cada panel en la ventana del cliente. Los destinos sin geometría verificada se mantienen ausentes: no se dibuja una flecha hacia un punto estimado. La guía junto al campo y al mensaje sí usa geometría real dentro de la app móvil. Respeta el pin, las zonas permitidas, el teclado y los controles. Las reacciones distinguen envío en curso, cola, confirmación y fallo; una respuesta nueva puede activar lectura sin interrumpir la escritura propia.

Quickshell conserva las notificaciones y sus acciones en el historial. Su puente ofrece únicamente el aviso temporal a Capri. Sólo omite el popup normal después de recibir confirmación de la superficie visible: el globo para mensajes, o el sprite para un gesto de archivo; si Capri está desactivada, ocupada, oculta manualmente, sin espacio para el globo o no confirma a tiempo, aparece el popup original. Se conserva No molestar. El globo es una ventana propia junto a Capri, sin otro personaje ni un fondo rectangular detrás del sprite. Las capturas guardadas y las descargas completadas reconocidas activan el gesto de archivar sin globo. Los errores conservan su aviso hablado; mencionar una captura en Slack no convierte ese mensaje en un evento de archivo. La instalación del puente conserva respaldos y permite restaurar la configuración original.

La APK 0.20.5 conserva la firma de 0.20.4 y contiene los 122 archivos web exactos de la compilación, incluidos los seis atlas animados. Pasan 48 pruebas Android, sin errores de Lint, y diez casos de navegador móvil. La descarga HTTPS coincide con el SHA-256 del paquete construido. La prueba nueva comprueba escritura, seguimiento del envío y reacciones con la posición fijada. Sigue pendiente probarla en el teléfono físico.

La suite nativa pasa 494 pruebas. La prueba aislada de WebKit y D-Bus confirma un globo real en 120 ms y devuelve el aviso al sistema en 472 ms cuando no hay confirmación. También verifica que una oferta concurrente rechazada nunca se dibuja después, que las cancelaciones no esperan al recibo y que música, pin, áreas excluidas y control del equipo mantienen su comportamiento. El acceso circular tiene una regla propia que conserva su ausencia de borde y decoración aunque cambie de escritorio virtual, sin alterar su fondo, redondeo ni transparencia.

### Avisos compactos en 0.20.6

El personaje permanece sin marco, fondo ni insignia de exclamación, incluso al recibir una pregunta. El foco de teclado se señala sobre su silueta; el acceso circular conserva su estilo. En móvil también desaparece el contorno rectangular al enfocar al personaje.

El aviso de escritorio ocupa 220 × 80 píxeles lógicos. No tiene encabezado ni un botón adicional: tocar el texto de una pregunta selecciona la sesión en Herdr. El cierre está en la esquina. Los avisos largos se resumen visualmente dentro de ese espacio y conservan su contenido completo en el historial del sistema. La región que recibe clics respeta las esquinas redondeadas del aviso; el espacio transparente permite seguir trabajando debajo.

Esta revisión pasa 36 pruebas de interfaz, doce capturas de comprobación visual y la navegación móvil con teclado. La prueba nativa verifica el personaje enfocado sin marco y el aviso real de 220 × 80; confirma su dibujo en 100 ms y el retorno al aviso del sistema en 456 ms si falta confirmación. La suite Rust pasa 495 pruebas. La APK 0.20.6 conserva la firma y la vinculación, contiene los 122 archivos web exactos de la compilación y pasa las 48 pruebas Android. La descarga HTTPS está verificada; el teléfono físico sigue pendiente.


### Mensajes atribuidos y gestos de archivo en 0.20.8

Capri distingue a quien envía un mensaje de quien lo entrega. Un aviso reconocido de Slack aparece como «Alex Rivera te escribió en Slack.» y debajo conserva las palabras de Alex como cita. Se usan metadatos del emisor o el formato específico del mensaje. Si una notificación web llega identificada sólo como Chrome o Firefox, se puede conservar el remitente de ese formato sin inventar el sitio de origen; no se deduce un nombre de cualquier texto que contenga dos puntos. Los títulos sustantivos, errores y solicitudes de autenticación se conservan. Los mensajes externos tienen hasta 260 × 96 píxeles lógicos; las preguntas de sesión conservan 220 × 80. El contenido completo y las acciones originales siguen en el historial del sistema.

Una captura guardada o descarga completada reconocida reproduce seis cuadros de Capri guardando una hoja en una carpeta. El atlas de acciones se precarga al activar el personaje para evitar su carga inicial durante el plazo del aviso. Sólo la ventana del personaje puede confirmar que ese gesto llegó a dibujarse, una vez por aviso. Si no carga el sprite, otra pregunta tiene prioridad o no hay confirmación dentro del plazo, Quickshell conserva el aviso habitual. No molestar se respeta. Las burbujas de móvil y escritorio no tienen contornos verdes; las tarjetas de preguntas móviles usan un borde neutral.

El atlas `capri-motion-actions-v1.png` añade guardar, sentarse y hacerse a un lado con transparencia real. Su manifiesto y `generation-prompts-v8-actions.txt` conservan cuadros, tiempos y procedencia de imagegen integrado. La pose sentada tiene un punto de apoyo medido, para alinear el asiento con el borde real del editor.

En Linux, la colocación contextual requiere la geometría del editor de una sesión nueva, el acceso privado de Kitty y, para Herdr, el informe optativo de su cliente. Se combinan únicamente medidas numéricas del editor, panel, celdas y ventana; no se lee el borrador ni se toma una captura. Los datos caducados, paneles desplazados, superposiciones y ventanas ajenas se rechazan. Capri se sienta en el borde antes de escribir y se aparta a la derecha, izquierda o por encima mientras escribes, siempre dentro del espacio permitido. Una posición fijada no se mueve. Las sesiones y clientes que ya estaban abiertos conservan sus extensiones anteriores; esta actualización no los recarga.

La APK 0.20.8 conserva la firma, incluye los 123 archivos web exactos y siete atlas animados. Pasan 48 pruebas Android y no hay errores de lint. La descarga HTTPS coincide con el SHA-256 del archivo construido. Las pruebas de interfaz cubren atribución, cita literal, prioridades y confirmación sólo tras decodificar y dibujar el recurso; veinte capturas revisan las burbujas y gestos a tamaño real. Sigue pendiente probar esta APK en el teléfono físico.


La actualización de Linux se instaló y pasó 18 comprobaciones del producto, con las cuatro sesiones externas y sus procesos conservados. Pasan 501 pruebas Rust. WebKit real comprobó la atribución de origen, el gesto dibujado con alfa, un único recibo por aviso y el retorno al sistema sin recibo. La prueba del puente instalado aceptó su mensaje de prueba en 101 ms y la descarga en 80 ms; son mediciones de esas dos pruebas, no una promesa de latencia general. El puente mantuvo el mismo proceso de Quickshell y cerró exclusivamente sus avisos de prueba.

El cliente opcional de Herdr, su parche reproducible y el procedimiento para abrir una ventana compatible están documentados en [scripts/linux/herdr-companion](../scripts/linux/herdr-companion/README.md). Se conserva el Herdr instalado; no se abre ni sustituye una ventana de trabajo automáticamente.

En este equipo está preparado el acceso **Herdr con Capri** en el lanzador de aplicaciones. Abre un cliente nuevo contra el servidor existente; no reemplaza Herdr ni recarga las sesiones actuales. Para que Capri pueda sentarse en el borde exacto del editor, inicia una sesión compatible desde esa ventana. Las sesiones anteriores conservan su integración hasta un inicio nuevo. El cliente opcional pasó una prueba aislada con geometría real, caducidad y limpieza de procesos; no se abrió una ventana de trabajo para esa comprobación.
