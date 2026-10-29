# Actualización del daemon para Capri iOS

Al 29 de octubre de 2026, los cambios de historial y audio ampliado están en el repositorio, pero el servicio activo de Gentle Dot no se ha actualizado. Mantenerlo en ejecución mientras haya trabajos activos: la recuperación de archivos de sesión no demuestra que una ejecución, una pregunta o un permiso en curso sobreviva a un reinicio.

## Estado observado

- `gentle-dot.service` estaba activo y su unidad usa `KillMode=control-group`. El desktop posee el proceso Node del daemon y éste posee el proceso de Pi; reiniciar la unidad detendría ese árbol y cerraría las conexiones.
- El daemon activo ejecuta `packages/daemon/src/cli.ts` de este repositorio. Modificar el código en disco no acredita que el proceso ya cargado esté ejecutando los cambios; algunas cargas diferidas pueden tener un ciclo distinto. La capacidad debe comprobarse en el proceso que atiende la conexión.
- `/health` informó `idle` para el asistente principal. Una consulta de sólo lectura a Herdr informó tres agentes con sesión: un Codex `working` y dos Pi `idle`. Es una fotografía, no un bloqueo que impida que el estado cambie. Esta consulta no acredita que no haya preguntas o permisos pendientes.
- El proceso Node activo ejecutaba la versión 26.11.1 desde un ejecutable sustituido en disco; `node` al consultar la máquina era 26.12.1. Una futura ejecución usaría el ejecutable disponible entonces, por lo que debe verificarse como parte de la actualización.

## Evidencia aislada

Se ejecutó Pi RPC real offline con datos sintéticos en un directorio temporal. Dos procesos sucesivos reabrieron la misma sesión ramificada y su cadena previa, conservaron identificadores y mensajes, y marcaron la sesión anterior como rama no verificada. El procedimiento está en `.cache/isolated-pi-reopen-audit.mjs`; es un diagnóstico local, no un artefacto de despliegue.

También pasaron 50 pruebas de supervisor, rotación, sincronización de trabajos y Pi RPC real. Entre ellas, una transferencia sintética de 26 MiB se reabrió después de perder su confirmación. Estas pruebas no verifican una instalación real, una inferencia activa, prompts o herramientas en vuelo, ni la supervivencia de conexiones o autorizaciones.

## Condiciones para una actualización futura

1. Preparar y verificar una versión concreta en un entorno aislado, con sus dependencias, Node y configuración equivalentes. Confirmar que el proceso nuevo anuncia `historyPaging: 1` y los límites ampliados de audio; sin esos anuncios, el iPhone conserva los límites y la conducta legacy.
2. Establecer una barrera real de inactividad: el estado instantáneo `idle` no basta si todavía pueden entrar solicitudes, hay herramientas ejecutándose o existen preguntas, permisos, transferencias o resultados sin confirmar. El código actual no ofrece una transferencia de propiedad sin interrupción de todo ese estado.
3. Conservar y verificar archivos de sesión, cadenas y trabajos durables sin imprimir credenciales ni datos de conversación. Tener una reversión comprobable de la versión anterior. No inferir que una solicitud fue aceptada o terminada sólo por haber sido enviada.
4. Al efectuar una sustitución controlada, esperar desconexión y reconexión de clientes. Verificar identidad de sesión, historial, inventario Herdr, permisos pendientes y reanudación de transferencias antes de declarar el servicio listo. Una prueba en reposo no garantiza continuidad de trabajos en vuelo.

No se reinició el servicio, no se modificó el binario instalado y no se desplegaron los cambios durante esta investigación.
