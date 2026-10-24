# Un acompañante sobre otras apps en Android

Gentle Dot 0.21.0 añade un personaje nativo transparente que abre la conversación en una ventana parcial. Capri es un tema opcional incluido en el fork; el modo Gentle sigue disponible. Los mensajes y las sesiones conservan la conexión privada existente con el PC por Tailscale: el personaje puede permanecer en pantalla con el PC apagado, pero el asistente necesita que el PC esté conectado.

## Activarlo

1. Vincula el teléfono con el QR de tu equipo y abre **Ajustes → Este teléfono**.
2. Activa **Sobre otras apps**. Si falta el permiso, Android abre su pantalla **Mostrar sobre otras apps**; concédelo y vuelve a Gentle Dot; se completa la activación que solicitaste.
3. Sal de la aplicación. El personaje aparece sin recuadro ni fondo. Capri se elige con el selector de tema habitual; no se activa por instalar el APK.
4. Arrastra el personaje para colocarlo. Mantén pulsado para fijar o soltar su posición; también hay un interruptor **Fijar posición** y acciones equivalentes para lectores de pantalla.
5. Tócalo para abrir la conversación al 88% de la altura de pantalla. **Cerrar** o Atrás la colapsan. El acceso **Ocultar** de la notificación persistente detiene el acompañante.

El acompañante sobre otras apps requiere Android 8 o posterior. Android 7 conserva la aplicación y sus notificaciones normales. La concesión del permiso es una acción del usuario: instalar o abrir ajustes no inicia el servicio.

## Cómo se comporta

| Situación | Resultado |
|---|---|
| La app principal o la conversación parcial están visibles | El sprite nativo se oculta; no duplica al personaje de la app. La conversación parcial no añade otro sprite web. |
| Llega una pregunta o respuesta del monitor existente | El personaje reacciona y muestra un aviso breve, sin contorno verde. Tocar una alerta de sesión abre esa sesión solo si su identidad sigue coincidiendo. |
| El aviso se dibuja correctamente | Android conserva la notificación en el historial en un canal discreto; evita una segunda presentación invasiva. |
| Falta permiso, la ventana no se dibuja o el personaje está detenido | Se conserva la notificación normal de Android. |
| Pantalla apagada o teléfono bloqueado | Se retiran las ventanas y se detiene la animación. No muestra contenido sobre el bloqueo. |
| No molestar o notificaciones desactivadas en Android | El personaje no presenta el aviso; Android conserva el control de su ruta normal. |
| Ahorro de batería o animaciones desactivadas por accesibilidad | El personaje permanece quieto. |
| Reposo, con movimiento permitido | Un ciclo breve de animación seguido de 30 segundos sin redibujado continuo. Los eventos disparan acciones concretas. |
| Android termina el servicio | No se reinicia desde el fondo; puedes reactivarlo desde ajustes. |

Al pasar una ventana del chat al fondo, se cierra su conexión WebSocket; al volver se recupera el historial sin reenviar mensajes. El monitor nativo de avisos puede seguir conectado si lo activaste.

Los ajustes de alertas existentes siguen filtrando qué eventos se entregan. El ajuste **Contenido en pantalla bloqueada** afecta a las notificaciones del sistema. El texto del acompañante solo aparece mientras el teléfono está desbloqueado. No solicita un servicio de accesibilidad, captura la pantalla ni lee lo escrito en otras aplicaciones.

La conversación parcial reutiliza el chat y el almacenamiento seguro existentes. Al colapsarla conserva su actividad y los adjuntos en memoria. El texto del borrador se guarda cifrado por identidad de dispositivo y conversación; no se envía solo. Ambas ventanas usan revisiones compartidas para que una escritura atrasada no restaure un borrador que ya enviaste o borre texto más reciente. Los archivos adjuntos en memoria no sobreviven a que Android termine el proceso.

## Implementación y compilación

`CompanionOverlayService` crea ventanas `TYPE_APPLICATION_OVERLAY` ceñidas al personaje y al aviso; no captura los toques de toda la pantalla. Es un servicio `specialUse` iniciado por el usuario y con notificación persistente. `CompanionSpriteView` dibuja fotogramas y polígonos del atlas con alpha real; no mantiene un segundo WebView para animar.

Los sprites proceden de [`packages/theme-capri`](../packages/theme-capri). Gradle genera únicamente los manifiestos nativos que apuntan a los PNG ya empaquetados por Vite, evitando duplicar los atlas en el APK. No edites los assets generados en Android.

Requiere JDK 21, Android SDK 36 y las dependencias del workspace. Desde la raíz del repositorio:

```sh
node scripts/mobile/build-android.mjs --lint
```

El script compila el cliente, sincroniza Capacitor, construye un APK local y comprueba firma y alineación. No instala en un teléfono ni publica la descarga. Para actualizar una instalación existente, usa el mismo certificado de firma; no cambies `applicationId`.

## Verificación

Hay pruebas de la política de visibilidad, límites de pantalla, ahorro de energía, selección de acciones, activación explícita, errores de inicio y almacenamiento de borradores. Las pruebas de vinculación conservan el origen HTTPS de Tailscale como requisito. La compilación y el lint de Android se ejecutan sobre el APK completo.

La visualización sobre otras apps, los fabricantes con ahorro agresivo, el teclado de la actividad parcial y las mediciones de batería requieren una prueba física. Una compilación y las pruebas web no sustituyen esa comprobación. Antes de distribuir en Google Play, revisa la declaración de [`specialUse`](https://developer.android.com/develop/background-work/services/fgs/service-types) y las [restricciones de servicios en segundo plano](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
