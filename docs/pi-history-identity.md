# Identidad de mensajes de Pi y archivo de Capri

El archivo del iPhone puede conservar dos registros de un mismo turno: uno recibido en vivo y otro recuperado del historial. Todavía no existe un vínculo durable que pruebe que son la misma fuente. No se debe unir ni borrar registros por texto o por posición.

## Evidencia comprobada

- El bridge genera IDs en vivo por instancia; desde `5e924c2` no reutiliza la misma secuencia tras reiniciarse. Los IDs históricos se generan por archivo y posición de turno y son distintos.
- Pi 1.0.4 emite `message_end` antes de guardar la entrada. En `turn_end` su extensión recibe el `messageEntryId` del asistente ya guardado. La prueba `packages/daemon/test/pi-identity-boundary.integration.test.ts` usa una sesión Pi real y una respuesta local simulada.
- En esa prueba, dos turnos idénticos obtuvieron IDs de entrada distintos. El orden observado para ambos fue `message_end`, señal de prueba, `turn_end`. La señal simulada contenía sólo IDs, sin texto del usuario ni respuesta. Cambiar el suscriptor no cambia las entradas, pero esa prueba **no** demuestra recuperación durable de señales perdidas.
- `persistedPiMessageIdentity` sólo acepta una referencia exacta dentro de la rama y la sesión esperada; rechaza casos ambiguos y copias rehidratadas. No está conectado al runtime. La serialización JSON del proceso Pi al supervisor pierde la referencia de objeto.
- `dot-live-input.ts` ya emite `ctx.ui.setStatus` en modo RPC y `bridge.ts` recibe estos eventos; la extensión del chat principal se carga mediante `guardArgs` cuando se configura `agentHome`. Que una señal tenga la forma correcta no demuestra por sí solo su origen ni una escritura durable.
- La consulta de lectura del host activo devolvió cuatro sesiones en inventario y respondió a la inspección de tres con IDs; cada una devolvió cinco mensajes de texto. Esa comprobación no prueba el iPhone ni la proyección nueva todavía no desplegada.
- `identity-binding-store.ts` es un almacén experimental separado: guarda únicamente identificadores, rechaza conflictos y confirma los cambios mediante transacciones SQLite. Las pruebas cubren procesos competidores, reintento idéntico y terminación antes del commit. El almacén no autentica su entrada y aún no está conectado al bridge ni a Archivo.

## Condiciones antes de integrarlo

1. Vincular la señal al proceso Pi y sesión correctos mediante un canal de confianza; evitar que otra extensión o una señal tardía pueda atribuir una entrada a otro turno. Definir límites, formato y compatibilidad con clientes y hosts anteriores.
2. Correlacionar la señal de Pi con el ID vivo exacto en el bridge, demostrando el orden ante herramientas, interrupción, cambio de sesión, reinicio y concurrencia. Los turnos de usuario requieren su propia evidencia; el ID de `turn_end` corresponde al asistente.
3. Guardar el vínculo de forma atómica y durable en el host antes de anunciarlo, con IDs estables, revisión y recuperación tras interrupción. Una señal emitida sólo en memoria no permite reparar una desconexión.
4. Exponer en el historial las identidades fuente reales de Pi. Un turno visual puede reunir varias entradas de asistente; no se debe asumir una correspondencia uno a uno. Mantener aisladas las sesiones y las ramas.
5. Hacer que Archivo y sus escritores coordinen el vínculo y la recuperación ante carreras, cuotas y cierres. Preservar las dos fuentes y sus actividades; si el vínculo es incierto, conservarlas separadas. Comprobar búsqueda, paginación y exportación sin suprimir mensajes repetidos legítimos.
6. Probar actualización progresiva con host anterior y nuevo, reconexión, reinicio y fallos entre cada escritura. La app instalada y el daemon existente no adquieren estas capacidades hasta recibir sus respectivas actualizaciones.

No se ha activado una migración ni deduplicación de Archivo, y no se ha desplegado ni reiniciado el daemon por esta investigación.
