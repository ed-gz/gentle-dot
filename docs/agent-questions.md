# Responder preguntas de Pi y Gentle Shell

Desde **Agentes**, responde las preguntas estructuradas de las sesiones que cargan el adaptador actual de Gentle Dot. Cada respuesta corresponde a una solicitud concreta: elegir una opción no autoriza acciones futuras.

## Uso rápido

1. Abre la sesión y revisa el detalle completo de la tarjeta.
2. Elige las opciones o edita el texto. Pulsa **Enviar** explícitamente; seleccionar o escribir no envía nada.
3. Comprueba **Respuesta enviada**. **Cancelar** devuelve una cancelación, no una respuesta afirmativa. En confirmaciones, **Rechazar** devuelve una negativa.

## Preguntas compatibles

| Tipo | Comportamiento |
|---|---|
| Confirmación estándar | **Permitir** o **Rechazar**, sólo para esa solicitud. |
| Selección estándar | Devuelve exactamente la opción original, sin interpretar su etiqueta como un permiso. |
| Texto estándar | Conserva espacios y saltos de línea. Puedes enviar texto vacío explícitamente. |
| Editor estándar | Carga el documento original en el campo editable. Conserva espacios y saltos de línea; vaciarlo y enviar devuelve un documento vacío. |
| Gentle Pi `ask_user_choice` | Conserva el valor interno original de la opción. **Otra respuesta** sólo está disponible cuando la herramienta permite texto personalizado. |
| Gentle Pi `ask_user_question` | Admite selección simple/múltiple, descripciones, previews y respuesta personalizada. En selección múltiple puedes conservar opciones marcadas y añadir texto, como en Gentle Shell. Completa cada pregunta antes de enviar. |

El editor remoto resuelve la misma solicitud que el editor del equipo. Para poder cerrarlo al recibir una respuesta remota, el adaptador utiliza el componente de editor de Pi dentro de un diálogo con cierre controlado. La primera respuesta válida gana; cerrar la sesión o usar **Detener** cancela el editor pendiente. Los diálogos estándar tienen un plazo máximo de diez minutos. Los formularios nativos de Gentle Pi pueden no tener fecha límite.

Los textos de entrada y editor se validan en el equipo: hasta 64 KiB UTF-8, sin caracteres NUL. El campo de texto estándar mantiene su límite visual de 8192 caracteres. Las solicitudes demasiado grandes para publicarse completas permanecen en el equipo; no se truncan para presentarlas como respondibles.

## Si no puedes responder

- **Solicitud vencida:** ya no se puede enviar una respuesta. Consulta la sesión para obtener la solicitud vigente.
- **Conexión anterior:** responde la solicitud actual en el equipo. Actualizar el adaptador sirve para próximas solicitudes, no para tomar control de una ya abierta. Consulta [la conexión de sesiones](mobile-orchestration.md#trabajar-con-sesiones).
- **Interfaz de terminal no compatible:** responde o cancela en la terminal original. Puedes usar **Detener** para solicitar la interrupción del trabajo, pero una interfaz personalizada puede requerir cerrarla en el equipo. Gentle Dot no simula teclas ni inventa una aceptación genérica.

Sólo los formularios de las extensiones originales verificadas de Gentle Pi se adaptan desde `ui.custom()`. Se reconocen tanto la distribución incluida como las versiones verificadas de Gentle Shell que registran las respuestas del usuario: esa instrumentación antes hacía que los formularios aparecieran como incompatibles. Las versiones compatibles se identifican por el contenido exacto del archivo; una herramienta con el mismo nombre o título, pero otro código, no obtiene ese canal. Las restricciones de identidad, conexión, permisos y vencimiento siguen aplicándose a todas las respuestas.

Los permisos de revisión requieren el puente cooperativo del proveedor. El adaptador ampliado conserva tres decisiones independientes: revisar este cambio, rechazarlo o permitir revisiones posteriores en esa sesión y repositorio. La tercera opción muestra el alcance y el efecto originales del permiso; sólo la selección explícita de esa opción puede activar el permiso de sesión. El proveedor conserva sus comprobaciones del candidato, sesión, repositorio y revocación.

## Compatibilidad con la instalación actual de Gentle Shell

El instalador preparado en `scripts/orchestration/install-review-bridge.mjs` verifica las huellas exactas de los tres archivos del proveedor antes de preparar el puente de revisión. Por defecto sólo comprueba: no toca fuentes ni procesos. `--apply` instala el puente y conserva copias originales; no reinicia sesiones. Si la versión de Gentle Shell cambió, rechaza la instalación y deja los archivos intactos.

```sh
node scripts/orchestration/install-review-bridge.mjs /ruta/a/gentle-pi --check
# Instalar en un momento sin solicitudes pendientes:
node scripts/orchestration/install-review-bridge.mjs /ruta/a/gentle-pi --apply
```

La instalación referencia el módulo del puente en este checkout de Gentle Dot; conserva esa ubicación mientras lo uses. Después de instalar, recarga Gentle Shell cuando no haya una pregunta pendiente. Los adaptadores cargados en procesos existentes mantienen su código hasta una recarga o un nuevo inicio; actualizar archivos no cambia una solicitud ya abierta.

Una pantalla personalizada sin puente sigue visible en la app con su título, estado de espera e instrucciones para responder en la terminal. **Actualizar solicitud** permite comprobar si ya se resolvió. No se oculta ni se transforma en una aceptación genérica.
