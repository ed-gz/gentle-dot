# Respuestas móviles a preguntas del motor principal

Las preguntas generales de Pi permanecen en lectura en iOS. El código de prueba
`rpc-dialog-guard.ts` verifica la pregunta dentro del proceso consumidor, pero
todavía no existe un transporte con una frontera de seguridad demostrada. No
anunciar una capacidad de respuesta basándose sólo en esas pruebas.

## Evidencia

- `rpc-dialog-guard.test.ts` ejecuta Pi RPC real y comprueba el enlace de
  instancia, sesión, ID y revisión; rechaza respuestas antiguas, opciones
  inválidas y reenvíos. También comprueba la respuesta desktop heredada.
- `rpc-dialog-probe.test.ts` usa un shim de prueba, no instalado en producción,
  para comprobar que una pregunta del adaptador existente sustituida por otra
  con el mismo ID rechaza la revisión antigua en Pi RPC real.
- En esta máquina, un hijo sintético con el mismo UID leyó una variable
  sintética de `/proc/PPID/environ` después de que el padre la eliminó de su
  entorno. Los directorios 0700 y una clave entregada mediante variables de
  entorno no protegen esa clave frente a las herramientas del propio motor.
  Un intento separado de escribir en el stdin del padre por `/proc` falló; no
  demuestra que todos los demás descriptores estén aislados.
- `bwrap` y un namespace mínimo funcionan en esta máquina, pero esa prueba no
  aísla todas las herramientas, procesos MCP y extensiones que pueden acceder a
  los recursos del motor. La inspección de comandos del guard existente
  tampoco pretende ser un sandbox.

## Requisitos para habilitarlo

1. Demostrar una frontera OS que impida a todas las herramientas y extensiones
   no confiables leer o enviar mensajes por el canal de decisiones. Probar el
   comportamiento real de los sistemas y configuraciones soportados; fallar
   cerrado donde esa frontera no exista. Un descriptor oculto por sí solo no
   es evidencia suficiente.
2. Asociar la tarjeta a la instancia, sesión, ID y revisión exactos, y validar
   todo de nuevo en el consumidor, sin una espera entre la validación y la
   resolución. Mostrar íntegro el contenido que se está autorizando.
3. Mantener el flujo desktop anterior, sin correlacionar solicitudes por texto
   u orden. Los hosts sin la capacidad nueva siguen siendo sólo lectura en
   iOS; una solicitud antigua no puede degradarse al protocolo heredado.
4. Devolver una confirmación correlacionada del consumidor. Si la conexión se
   pierde después del envío, reflejar un resultado incierto y no reenviar la
   decisión automáticamente.
5. Probar cambio de pregunta, reemplazo de proceso y sesión, cancelación,
   respuestas concurrentes, pérdida de confirmación y denegación por clientes
   no autorizados, además del circuito real de iPhone a Pi.

El editor RPC queda fuera del primitivo de prueba: su API nativa carece de una
cancelación equivalente a las de confirmación, selección y entrada. Debe tener
su propio diseño antes de admitir respuestas remotas.
