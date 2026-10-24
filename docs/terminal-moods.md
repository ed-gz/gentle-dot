# Ambientes para una ventana de terminal

Gentle Dot y Capri pueden aplicar **Hacker**, **Afterlife** y **Atardecer**, y recuperar los colores anteriores con **Restaurar**. El alcance real es una ventana Kitty: todas las sesiones que compartan esa ventana ven el cambio. No se envían teclas ni texto a Gentle Shell.

## Cómo usarlo

1. Abre una sesión conectada y despliega **Ambiente de terminal**. También puedes pedirle a Capri un ambiente para una sesión concreta.
2. Selecciona el ambiente. Si la ventana contiene otras sesiones, confirma primero que quieres cambiar toda esa ventana.
3. Usa **Restaurar** para recuperar los colores guardados antes del primer ambiente. Cambiar de Hacker a Afterlife no reemplaza ese original.

Las ventanas antiguas sin control remoto muestran el motivo. Para crear una preparada, elige **Nueva sesión → Abrir en: Terminal → Crear sesión**. Las sesiones actuales siguen trabajando; no se reinicia Kitty ni Gentle Shell. Crear otra sesión dentro de Herdr conserva la ventana antigua y no añade un canal de control.

Las sesiones que comparten una ventana Kitty sin listener de control remoto no permiten cambiar su ambiente desde Dot. No se modifica su configuración para habilitar ese canal automáticamente.

## Alcance y restauración

Sólo cambian el fondo, el texto y los dieciséis colores ANSI de la ventana seleccionada. El cursor, selección, transparencia, bordes, pestañas, configuración y otras ventanas permanecen intactos. Las aplicaciones que pintan colores RGB propios pueden conservar parte de su apariencia.

El original vive en el objeto de la ventana Kitty, así que se conserva al reiniciar únicamente el daemon de Dot. Cerrar esa ventana o reiniciar Kitty descarta el original. Restaurar recupera tanto los valores como la herencia original de fondo/texto; no ejecuta el reinicio global de colores de Kitty.

Si otro programa cambia posteriormente la paleta, la lectura devuelve `mood: null` y mantiene `canRestore: true`: todavía puede restaurarse el original guardado. El servidor sólo confirma éxito después de verificar los colores aplicados. Un error de transporte después del envío deja un resultado incierto; se debe consultar el estado antes de afirmar éxito o reintentar.

## API y herramienta

Las dos operaciones requieren la autenticación habitual del dispositivo y un `paneId` conectado. Nunca aceptan PIDs, rutas, sockets, comandos ni colores arbitrarios del cliente.

```http
GET /api/mobile/terminal-mood?paneId=pi:IDENTIFICADOR
POST /api/mobile/terminal-mood
Content-Type: application/json

{"paneId":"pi:IDENTIFICADOR","mood":"hacker"}
```

`mood` sólo admite `hacker`, `afterlife`, `sunset` y `restore`. Para una ventana compartida, el POST necesita `allowSharedWindow: true` después del aviso y confirmación; sin ese campo responde `409` con código `SHARED_WINDOW`.

La lectura devuelve `available`, `paneId`, `scope: "window"`, `mood` (el ambiente actual o `null`), `canRestore`, `affectedPaneIds`, `sharedWindow` y `requiresSharedConfirmation`. Incluye `windowId` numérico y `verified: true` cuando Kitty confirma el estado. Si no está disponible devuelve `available: false` y `reason`; esto no significa que la sesión de Gentle Shell esté caída. `affectedPaneIds` contiene la sesión elegida y las otras sesiones conectadas conocidas que comparten ventana.

El POST devuelve el mismo estado verificado. Restaurar correctamente devuelve `mood: null`, `canRestore: false`. Los errores tienen `error` y `code`; `MOOD_UNAVAILABLE` y `MOOD_UNCONFIRMED` nunca se presentan como éxito. La UI consulta bajo demanda, sin añadir sondeo continuo.

El agente principal dispone de `set_terminal_mood` con esquema estricto para los mismos campos. Usa su canal local autenticado `/api/companion/agent`, separado del token del teléfono, y obtiene el `paneId` de las sesiones conectadas. La herramienta exige explicar el alcance compartido antes de usar `allowSharedWindow: true`. Cambiar a Capri no concede autorizaciones nuevas.

## Implementación y límites

La resolución verifica el manifest de la sesión viva, su identidad de proceso, el parentesco con Kitty, el socket UNIX privado propiedad de esa instancia y una única ventana coincidente. Se vuelve a vincular la sesión antes de ejecutar; el puente comprueba otra vez proceso y parentesco dentro de Kitty. No hay selección por ventana activa, títulos o expresiones aportadas por el cliente.

Las nuevas ventanas del lanzador Kitty ordinario reciben un socket aleatorio dentro de un directorio `0700` y `allow_remote_control=socket-only` como argumento de esa instancia. También se reconoce el lanzador instalado `systemd-run --user --scope --collect --quiet /usr/bin/kitty --`: conserva el scope independiente para que reiniciar Dot no termine la terminal. No se modifica `kitty.conf`, no se abre TCP y no se habilita control por TTY. Otros lanzadores personalizados conservan sus argumentos; no se añaden permisos a `--single-instance` ni a wrappers con opciones desconocidas. El directorio se elimina cuando termina la instancia si Dot sigue vivo; si Dot termina antes puede quedar un directorio temporal vacío o con un socket obsoleto, inaccesible a otros usuarios y nunca reutilizado.

El puente fijo `terminal-mood.py` usa el mecanismo `kitten` sin interfaz de Kitty y sus setters de `ColorProfile` para una ventana. Evita `set-colors`, que también tiene efectos sobre colores globales y transparencia. No carga rutas ni código proporcionados por las peticiones. El soporte actual requiere Linux, Kitty compatible y display gráfico para abrir ventanas. Validado con Kitty **0.49.2**; otros emuladores devuelven una razón de no disponibilidad.

## Verificación

`packages/daemon/test/terminal-mood.test.ts` cubre autenticación, validación estricta, identidad sustituida, revocación, ventanas compartidas, resultados no confirmados y permisos del lanzador. La prueba nativa opcional se ejecuta con `GENTLE_DOT_TEST_KITTY=1`: abre una instancia propia oculta con `--config NONE` y dos ventanas de prueba, comprueba los tres ambientes, la transparencia, el aislamiento de la segunda ventana y la restauración exacta después de recrear el controlador. No usa sockets ni sesiones del usuario. `runtime-build.test.ts` verifica que el paquete incluya el puente.

Referencias: [kitten sin UI](https://sw.kovidgoyal.net/kitty/kittens/custom/), [control remoto socket-only](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.allow_remote_control), [ColorProfile en Kitty 0.49.2](https://github.com/kovidgoyal/kitty/blob/v0.49.2/kitty/colors.c).
