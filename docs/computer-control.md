# Controlar el escritorio desde Gentle Dot

Gentle Dot puede usar las ventanas del equipo desde el chat del escritorio o del teléfono. El control se ejecuta en la aplicación de escritorio; el móvil envía la petición por su conexión privada. La disponibilidad depende del sistema gráfico, sus permisos y las herramientas instaladas.

## Usarlo

1. Mantén abierta la aplicación de escritorio de Gentle Dot y el equipo desbloqueado.
2. Pide una tarea concreta, por ejemplo: «Abre Zen, entra al espacio Trabajo y revisa el estado del proyecto que ya tengo abierto».
3. Dot comprueba las capacidades del escritorio y solicita el permiso de control cuando lo necesita. Puedes responder desde el chat de la aplicación de PC o desde un teléfono vinculado y autorizado; los permisos del sistema operativo y las contraseñas se resuelven en el equipo.
4. Dot observa una captura antes de actuar y revisa el resultado. **Ajustes → Aplicaciones y navegador → Control del equipo** permite revisar la disponibilidad y detener el control desde el móvil. La opción de detener en la bandeja del equipo sigue disponible; ambas cancelan las solicitudes de control pendientes.

Dot necesita un modelo que admita imágenes para interpretar las capturas. Si falta un requisito, debe señalar cuál falta; una respuesta antigua que dijera «no puedo controlar ventanas» no describe las capacidades actuales.

## Recibir una captura en el chat

Pide, por ejemplo: «Mándame una captura de YouTube en Zen». Dot activa la ventana correspondiente, toma la captura y comparte esa misma imagen. El chat muestra la imagen sin una tarjeta de acciones debajo. Tócala para abrir el visor: puedes ampliar y recorrer la imagen, descargarla y compartirla con los iconos superiores. En el móvil puedes usar dos dedos para ampliar. Cerrar el visor devuelve al mismo punto del chat. Esta vista requiere la APK 0.17.2 o posterior.

Las capturas que Dot utiliza internamente para orientarse no se adjuntan automáticamente. La herramienta `dot_share_screenshot` publica de forma explícita la última imagen nativa válida del turno y devuelve un enlace privado. El chat conserva el adjunto aunque el modelo omita ese enlace en su texto. Detener la tarea, cambiar de conversación o iniciar otra invalida las capturas sin compartir, para no enviar una imagen de un encargo anterior. Los archivos ya compartidos siguen sujetos a la autorización del teléfono.

## Elegir el navegador adecuado

| Petición | Cómo trabaja Dot |
|---|---|
| Investigar o abrir una web nueva | Navegador dedicado con referencias de elementos y perfil propio |
| Usar Zen, Chrome, Safari u otra aplicación ya abierta | Control visual del escritorio compatible, con la sesión existente |
| Continuar una sesión de un agente | Integración de **Sesiones**, que conserva la conversación y su canal de permisos |

El navegador dedicado no comparte las pestañas, cookies ni cuentas del navegador personal. El control visual sí puede usar su ventana y sesión abierta, pero no extrae cookies, lee pestañas ocultas ni conecta por sí mismo un depurador al navegador. Los espacios y menús se usan a través de la interfaz visible.

## Programas en otros espacios de trabajo

Que un programa no aparezca en la captura actual no significa que esté cerrado. Dot consulta los programas abiertos antes de iniciar otro. En Hyprland puede identificar ventanas de todos los espacios de trabajo, incluidos los que abres con **Super + 1, 2 o 3**, y activar la ventana concreta que corresponde al encargo. Si hay varias ventanas de una aplicación, utiliza sus títulos y espacios para elegir, sin abrir otra copia innecesaria.

Los metadatos dependen del escritorio. Cuando una plataforma sólo proporciona información del programa, Dot no inventa el espacio de trabajo ni la identidad de una ventana. La activación de una ventana existente requiere que siga presente y corresponda al programa indicado.

## Sistemas compatibles

| Entorno | Requisitos de control |
|---|---|
| macOS | Permisos de Accesibilidad y Grabación de pantalla para Gentle Dot; las capturas requieren macOS 14 o posterior |
| Linux con Hyprland/Wayland | `hyprctl`, `grim`, `wtype` y `wlrctl`, disponibles en la sesión gráfica del usuario |
| Linux con una sesión X11 | `xdotool`, `xprop` e ImageMagick (`import`) |
| GNOME o KDE sobre Wayland | Este control nativo todavía no está disponible; Dot debe informar el entorno incompatible |

En Linux, `gio` permite abrir aplicaciones por sus archivos de escritorio. La lectura de nombres y roles de controles utiliza AT-SPI cuando está disponible mediante Python 3 y sus bindings de accesibilidad. Esta lectura no recoge los valores de los campos. La presencia de `DISPLAY` dentro de Wayland no convierte toda la sesión en X11: Dot no usa XWayland como supuesto acceso al escritorio completo.

Si la distribución no tiene `wtype` o `wlrctl`, desde la raíz del repositorio puedes preparar las versiones fijadas con:

```sh
bash scripts/linux/install-computer-tools.sh
```

El script compila wtype 0.4 y wlrctl 0.2.2 desde revisiones concretas en `~/.local/lib/gentle-dot/bin`, sin `sudo`. Necesita Git, Meson, Ninja, pkg-config, un compilador C y las bibliotecas de desarrollo de Wayland y xkbcommon. No instala `grim`, `hyprctl` ni el escritorio: esos componentes deben estar disponibles mediante la distribución. Reinicia Dot después de instalar los auxiliares para que reconozca el entorno actualizado.

## Permisos y privacidad

Una autorización de control cubre los clics, el arrastre, la escritura y la navegación ordinaria durante esa sesión. Que una aplicación no publique el nombre de un botón o campo ya no provoca otra confirmación por cada interacción. Las acciones sensibles identificadas, como enviar, comprar o borrar, mantienen su confirmación. No se activa el modo sin confirmaciones ni se conceden permisos a otros conectores. La autorización de control dura 30 minutos; detener el control, cerrar la aplicación o su vencimiento la invalidan.

Mientras Dot captura o actúa, la rosa se aparta visualmente sin cambiar de posición. Si la ocultaste, permanece oculta. Esta ocultación temporal no modifica tu preferencia de visibilidad ni vuelve a centrarla.

El auxiliar nativo se registra a través del canal privado de la aplicación. Sólo escucha en la dirección local del equipo y usa una clave distinta por ejecución; el teléfono no recibe esa clave ni conecta directamente a este auxiliar. Abrir la aplicación móvil o una página web no registra un auxiliar nuevo ni concede control.

La sesión autorizada, los límites de acciones, el bloqueo de aplicaciones sensibles y las confirmaciones se comprueban fuera del modelo. El contenido de una página, una captura o una respuesta de otro agente no constituye una autorización. Dot no puede saltarse una denegación mediante comandos ni aceptar su propio diálogo. Las contraseñas, el desbloqueo del equipo y la autenticación administrativa se introducen directamente en el sistema, nunca en el chat. La instalación de Chromium se describe en [Autenticación del equipo](system-authentication.md).

El control termina si se detiene la sesión o cierra la aplicación. Tailscale transporta la conexión; no desbloquea el equipo ni proporciona permisos de captura. Las capturas se toman al trabajar, no como una transmisión de vídeo continua. Para limitar el coste del modelo, el contexto visual conserva la captura más reciente y sustituye las anteriores por una descripción breve de la acción; el historial original sigue conservado.

## Si no puede continuar

| Mensaje | Qué comprobar |
|---|---|
| No hay conexión de control del escritorio | Que se esté ejecutando la aplicación de escritorio actualizada, no sólo el servidor o la APK |
| Falta un permiso en macOS | Concederlo a Gentle Dot en los ajustes del sistema; después de recompilar puede ser necesario volver a concederlo |
| Falta una herramienta en Linux | Instalar el requisito indicado en la sesión gráfica correspondiente; no conceder acceso administrador permanente |
| No puede identificar el destino o el foco | Revisar la ventana y repetir desde una captura nueva; Dot no debe enviar pulsaciones a ciegas |
| Aplicación o campo protegido | Completar esa parte directamente en el equipo; cambiar de herramienta no elimina la restricción |
| Se perdió la conexión con el teléfono | Recuperar Tailscale y abrir la app; una acción sin respuesta no debe reenviarse automáticamente |
