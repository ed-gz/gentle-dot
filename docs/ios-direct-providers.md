# APIs directas de Capri iOS

`createProviderTools(connectionId)` ofrece herramientas de conversación para una
conexión `https-api` configurada con `provider`. Las herramientas usan rutas y
métodos declarados; el modelo no recibe tokens ni puede inventar un destino HTTP.
MCP permanece disponible para otros servicios y capacidades.

| Proveedor | Endpoint de configuración | Herramientas implementadas |
| --- | --- | --- |
| GitHub | `https://api.github.com/` | Repositorios, listado/lectura de issues, creación de issues con etiquetas |
| Slack | `https://slack.com/api/` | Conversaciones accesibles, historial paginado, envío de texto |
| Gmail | `https://gmail.googleapis.com/` | Búsqueda, lectura de mensajes, envío MIME con adjuntos locales verificados |
| Odoo | Base HTTPS de la instalación | Proyectos, búsqueda de responsables/tareas, creación y edición de tareas |

GitHub utiliza la versión REST `2026-03-10`. Los listados de repositorios e issues
aceptan página y devuelven hasta 20 elementos por consulta. Slack conserva los
cursores de respuesta y solicita 15 mensajes por lectura de historial; no reintenta
ante límites de frecuencia. Gmail devuelve IDs y pageToken en búsquedas y extrae
texto MIME para lectura; HTML sigue siendo texto no confiable, sin renderizar ni
abrir enlaces. Las lecturas no son un archivo completo de todas las cuentas.

## Credenciales y revisión

Antes de cada operación, `getValidProviderAccess` recupera o renueva la credencial
mediante el servicio OAuth/Keychain y devuelve la revisión actual de la conexión.
Los tokens manuales, incluidos PAT de GitHub y API keys de Odoo, usan el mismo
almacenamiento. No se almacenan secretos de clientes confidenciales. Los scopes,
permisos de cada cuenta y disponibilidad de API del proveedor determinan lo que
puede ejecutar realmente la app.

Cada escritura solicita aprobación mediante `ToolContext.askApproval`. La vista
incluye conexión, endpoint/ruta, revisión, operación completa y destino. Gmail añade
el remitente confirmado consultando el perfil autenticado. Odoo incluye la base de
datos y UID cuando aplica. Después de revisar se comprueba que la configuración no
cambió; los adjuntos se vuelven a verificar antes de enviar. Rechazar la revisión
no crea una ejecución ni envía la mutación.

El registro local se confirma como `executing` antes del envío. Una respuesta válida
queda registrada; una respuesta explícita de rechazo conserva `accepted:false`.
`succeeded` en el registro significa que se confirmó una respuesta del proveedor,
no que cualquier operación de negocio tuvo éxito. Los fallos ambiguos pasan a
`uncertain`, bloquean la misma huella y nunca se reenvían automáticamente. Las
respuestas completas de error no se imprimen ni se pasan al modelo como logs.

## Correo y archivos

El constructor MIME genera cabeceras From/To/Cc/Bcc, Subject UTF-8 codificado,
Date, Message-ID y MIME-Version; no admite cabeceras proporcionadas libremente.
Las direcciones son buzones ASCII sin nombres de presentación. El texto y los
adjuntos se codifican en base64 y el mensaje completo en base64url para Gmail.
Los nombres Unicode de adjuntos usan continuaciones RFC2231. Saltos de línea en
cabeceras y tipos MIME inválidos se rechazan.

Se admiten hasta cinco archivos, con un total máximo de 800 kB para permanecer
dentro del límite nativo de solicitud de 2 MiB después de la codificación. Cada
referencia incluye trabajo, archivo, nombre, tipo, tamaño y SHA-256. El lector
comprueba los metadatos guardados y la huella de los bytes; cambiar o eliminar el
archivo invalida el envío. No se descargan adjuntos externos durante el envío.

## Odoo

La conexión debe indicar `apiMode: json2` para Odoo 19 o `legacy` para el protocolo
JSON-RPC anterior. JSON-2 envía la API key como Bearer y permite el encabezado
`X-Odoo-Database`. Legacy requiere `database` y un `uid` confirmado y envía la API
key únicamente en el cuerpo HTTPS de `execute_kw`; nunca en la URL, vista de
aprobación o registro local. La respuesta JSON-RPC debe coincidir con el ID de la
solicitud.

No se exponen métodos arbitrarios: las rutas trabajan con `project.task`,
`project.project` y `res.users`. La edición modifica sólo los campos declarados.
Indicar responsables sustituye la lista de asignados; una fecha null retira la
fecha explícitamente. Las descripciones se escapan como texto antes de guardarse
en el campo HTML. La disponibilidad del modelo y campos concretos depende de la
instalación; una respuesta de error no se presenta como una tarea creada.

## Evidencia

Diez pruebas Node cubren rutas, controles de argumentos, revisión y cambio de
conexión, reserva antes del envío, fallos sin replay, MIME Unicode/cabeceras,
integridad de archivos, formatos Odoo y separación de credenciales. Usan fixtures
de API. No constituyen envío real de correo/mensajes ni validación contra cuentas
configuradas en un iPhone instalado.

Fuentes: [issues de GitHub](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10),
[historial de Slack](https://docs.slack.dev/reference/methods/conversations.history/),
[mensajes de Slack](https://docs.slack.dev/reference/methods/chat.postmessage),
[envío de Gmail](https://developers.google.com/workspace/gmail/api/guides/sending),
[API JSON-2 de Odoo](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).
