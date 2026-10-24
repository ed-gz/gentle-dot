# Alertas de Android con recuperación de conexión

Activa **Ajustes → Alertas → Con la app cerrada** para recibir avisos por la conexión privada de Tailscale. El teléfono y el equipo deben estar conectados y el equipo debe permanecer encendido. Android necesita tener permitidas las notificaciones de Gentle Dot.

## Entrega

Las respuestas y cambios de las sesiones llegan por el WebSocket existente en cuanto el equipo los publica. Antes se descartaban esos eventos y se esperaba hasta la siguiente consulta, cada diez segundos. La consulta periódica se conserva para recuperar cambios durante cortes de red. Ambos caminos comparten un registro acotado de identificadores para evitar avisos duplicados.

Las solicitudes de permiso recibidas por el socket desencadenan una consulta inmediata: el registro completo proporciona la identidad de la solicitud y permite retirar el aviso cuando se resuelve. Ninguna notificación concede un permiso ni responde por el usuario.

| Situación | Destino |
| --- | --- |
| Evento desconocido o silenciado | Sin aviso |
| App visible, avisos internos activos y listener disponible | Banner dentro de la app |
| App visible, avisos internos desactivados | Sin aviso |
| Aviso directo de la interfaz visible | La interfaz ya presenta el aviso |
| App en segundo plano | Notificación de Android |
| Se pierde el listener durante la entrega | Notificación de Android como respaldo |

Los ajustes de Android, los canales desactivados y No molestar siguen aplicándose. El estado en Ajustes diferencia conexión activa, reconexión y notificaciones bloqueadas por Android.

## Recuperación del servicio

El monitor usa START_STICKY para que Android pueda recrearlo después de recuperar memoria. Al activarlo explícitamente se guardan origen y token cifrados con AES-GCM y una clave del Android Keystore. Las credenciales no se escriben en texto plano y la app tiene copias de seguridad desactivadas. Una restauración inválida o que no puede descifrarse se descarta.

Al volver a abrir la app se recupera ese monitor si estaba activado y Android permite las notificaciones. **Detener avisos**, desactivar el interruptor, desvincular y revocar acceso eliminan el estado guardado. Cerrar una instancia por mantenimiento interno conserva la preferencia del usuario. El cambio no crea un servicio externo ni depende de Firebase.

Android puede posponer el reinicio, suspender la red o detener la app por restricciones de batería. Forzar detención impide recibir avisos hasta volver a abrirla; no se promete recepción mientras el proceso está forzado a detenerse. El historial de la primera conexión establece una referencia y no reproduce todas las respuestas antiguas. La recuperación tras una interrupción de red mantiene su cursor en memoria; una muerte completa del proceso puede perder avisos del intervalo sin conexión.

## Verificación

Se compilaron las clases nativas y pasaron las pruebas unitarias de Android con el SDK 36 y JDK disponibles en .cache/android. SessionNoticeLedgerTest comprueba entrega inmediata, deduplicación en ambos sentidos, historial inicial, reactivación y eventos inválidos. Las pruebas de interfaz y del adaptador verifican preferencias, la advertencia cuando Android bloquea avisos y el contrato de eventos.

La comprobación física sigue pendiente: no había un teléfono conectado para probar pantalla apagada, recuperación real del servicio ni la bandeja del sistema. Una compilación correcta no demuestra recepción en ese dispositivo.

Para probar en el teléfono, instala la compilación actual, activa los avisos y deja una sesión terminando mientras bloqueas la pantalla. Comprueba una respuesta y una solicitud de permiso, luego desconecta y reconecta Tailscale. Repite después de cerrar y abrir la app; desactivar avisos debe detener el servicio y evitar su recuperación.
