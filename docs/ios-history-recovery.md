# Recuperación del historial en Capri iOS

Una página anterior que llega mientras una reserva propia está bloqueada puede añadirse a esa reserva. La operación comprueba la identidad de la reserva y su base, el origen del host, los mensajes que ya contiene y que el contexto de la página siga vigente. No modifica el snapshot visible ni su huella de entrega de voz. Si la escritura del archivo falla, la página sigue en la reserva; la respuesta del host no avanza el cursor hasta que se confirme su almacenamiento. Una página de un contexto que cambió se conserva en la copia de rescate del escritor, sin agregarla a una conversación nueva.

La reserva y la copia de rescate son evidencias distintas. La copia no es un comprobante de sincronización, no se mezcla automáticamente y puede exportarse para revisión. La exportación conserva la advertencia `branchUnverified` y omite el texto privado de transporte.

## Límite conocido: procedencia entre escritores

Una página puede aportar la advertencia de rama no verificada a una identidad que una reserva anterior ya contiene sin esa marca. La ampliación rechaza reemplazar ese mensaje y conserva la advertencia en una copia de rescate separada. Sin embargo, una recuperación posterior de la reserva anterior todavía puede archivar y mostrar la entrada sin la advertencia si la copia con la marca sigue aparte. El descarte de la copia también elimina esa evidencia. La corrección de páginas no resuelve esta carrera de procedencia y no debe interpretarse como verificación de la rama.

Una solución completa requiere conservar la advertencia por identidad y coordinar su aplicación a la reserva, el archivo, la vista y el contexto del modelo, incluso entre ventanas y tras una interrupción. El archivo y la reserva utilizan almacenes IndexedDB diferentes. La revisión humana debe conservar las evidencias, comprobar las versiones exactas y ser reanudable; no debe modificar ni recalcular una huella de voz sin verificar su recibo. Hasta implementar y probar ese flujo, revisar y exportar las copias antes de descartarlas.

## Verificación y reversión

En una copia aislada del frontend, Chromium ejecutó 54 pruebas de reservas, paginación, copias de rescate y persistencia: 54 correctas. Se comprobó la recuperación después de un fallo de archivo, el cursor, la ejecución concurrente de recuperación, el cambio de contexto seguido de un guardado y el límite de 10.000 entradas. El límite de 64 MiB no se probó de forma independiente. El typecheck de iOS terminó correctamente. La prueba usa un host simulado y no valida el dispositivo ni una sesión real de Pi.

La unidad puede revertirse junto con sus cambios de paginación en `conversation-journal.ts`, `journal-conversation-persistence.ts` y `main.ts`, sus pruebas y este documento. Las correcciones anteriores de exportación de copias son independientes.
