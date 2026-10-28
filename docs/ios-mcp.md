# Conexiones MCP de Capri iOS

Capri puede descubrir herramientas de un servidor MCP remoto configurado por el
usuario. No hay una lista fija de proveedores. El endpoint usa HTTPS; la credencial
Bearer opcional se guarda en Keychain y nunca se entrega al modelo. También se puede autorizar un cliente OAuth público nativo previamente registrado por el servicio. Los servicios
deben ofrecer Streamable HTTP con MCP `2025-06-18` y respuestas JSON o SSE que
terminen dentro de 30 segundos y 2 MiB. Esto requiere internet; no depende de la PC.

## Configuración y almacenamiento

`external-connections.ts` exporta `listConnections`, `getConnection`,
`saveConnection(input, token?, expectedRevision?)` y `removeConnection`.
Los campos de configuración persistidos son `id`, `kind`, `label`, `endpoint`,
`revision`, `enabled`, `credentialAccount`, `createdAt` y `updatedAt`.
`credentialAccount` es un identificador UUID, no la credencial. El valor de Keychain
es JSON bajo el scope `external-connections`: token y, cuando se usa OAuth, renovación, vigencia y recurso/emisor/endpoints vinculados.

Al guardar, un token vacío configura acceso sin autenticación; omitirlo conserva la
credencial existente. Cambiar un endpoint autenticado exige proporcionar de nuevo
la credencial o indicar explícitamente que no se usará. Una rotación crea otro
account de Keychain, confirma la revisión de metadata con una transacción y después
retira la credencial anterior. Un fallo de metadata no sobrescribe el token de la
configuración que sigue vigente. Las revisiones concurrentes no se sobrescriben.
No se permiten userinfo, fragmentos ni parámetros habituales de credenciales en
el endpoint. Hay un máximo de 32 conexiones.

La configuración admite el tipo `https-api` para otros adaptadores; esta unidad
ejecuta únicamente conexiones `mcp`. OAuth y los adaptadores particulares son
unidades separadas. Las conexiones abiertas en Codex no autentican Capri.

## Descubrimiento, conversación y aprobación

`discoverMCPTools(connectionId)` inicializa la sesión, envía
`notifications/initialized` y consulta `tools/list` con paginación. Conserva
`Mcp-Session-Id` en memoria y utiliza `MCP-Protocol-Version` en las solicitudes
posteriores. El resultado es un arreglo de `Tool` compatible con el registro local;
sus nombres `mcp_<hash>` son estables por conexión y herramienta.

El descubrimiento admite hasta 64 herramientas, diez páginas y 512 KiB de catálogo.
Cada esquema individual puede ocupar 16 KiB. Se validan tipos, propiedades,
obligatorios, referencias locales, combinaciones, enumeraciones, constantes y
límites de números, textos y arreglos. Las restricciones no implementadas —por
ejemplo patrones regulares o referencias externas— producen un error explícito
antes de ejecutar. No se ignoran para fingir compatibilidad.

Cada llamada solicita una revisión humana dentro de la conversación, incluso si el
servidor la anuncia como lectura. La revisión contiene endpoint, revisión de
conexión, nombre remoto, esquema y argumentos exactos. Después de la aprobación se
reconsulta el catálogo y se compara el esquema, descripción y configuración. Un
cambio invalida la aprobación. Los tokens nunca forman parte de esa revisión.

El cliente no anuncia sampling, raíces ni elicitación; no ejecuta solicitudes que
envíe el servidor. Los resultados se marcan como datos no confiables. Los enlaces y
recursos devueltos no se abren automáticamente. Se rechazan redirecciones HTTP y
respuestas JSON-RPC no correlacionadas o duplicadas. Los SSE se procesan sólo cuando
la respuesta finita termina; no se mantiene un canal de escucha permanente.

## Evidencia de ejecución y límites

Antes de `tools/call`, `beginRemoteExecution` guarda una reserva `executing` con
requestId estable, conexión/revisión, endpoint, esquema, argumentos y huella de la
operación. La comprobación de duplicados y la reserva usan una transacción atómica.
Una respuesta correlacionada y válida pasa a `succeeded`; ese estado confirma la
respuesta del servidor y puede contener `isError: true` si falló la herramienta.
No significa por sí mismo que una operación de negocio tuvo éxito.

Un fallo de transporte, respuesta inválida o pérdida de confirmación conserva
`uncertain`; un reinicio no cambia `executing` a exitoso. La identidad estable de
la operación es conexión, endpoint, nombre de herramienta y argumentos canónicos.
Si sigue `executing` o `uncertain`, bloquea otra llamada incluso después de una
aprobación nueva, un esquema distinto o una rotación de token/revisión. El esquema
y revisión siguen vinculados a la aprobación y evidencia; no reinician la protección
contra duplicados. IndexedDB versión 2 añade un índice compuesto a los registros
existentes sin borrarlos, incluyendo huellas antiguas que incorporaban el esquema.
La comprobación consulta claves del índice sin cargar los resultados guardados.
No hay reenvío automático de mutaciones ni recuperación SSE mediante replay.
Las sesiones caducadas exigen volver a descubrir las herramientas, sin repetir la
operación anterior. El registro admite hasta 1000 ejecuciones y conserva resultados
de hasta 2 MiB. `listRemoteExecutions` permite mostrar la evidencia; todavía no hay
una resolución automática de resultados inciertos, que requieren contrastar con
el servicio.

Nueve pruebas Node verifican negociación, sesiones, paginación, validación,
aprobaciones, cambios durante revisión y fallos sin replay. Cuatro pruebas de
navegador verifican transacciones reales de IndexedDB, concurrencia, restauración
y migración de un journal versión 1. Cambiar esquema o credenciales mantiene el
bloqueo; argumentos distintos siguen creando una operación nueva revisable.
Son fixtures de protocolo, no evidencia de autenticación contra un proveedor real
ni de ejecución de URLSession en el iPhone instalado.

Referencias de protocolo: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
y [herramientas MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## OAuth de otros servicios

En Ajustes → Conexiones → MCP remoto, el acceso «Autorizar cuenta» usa el client ID público del servicio. El callback nativo es `dev.gentledot.capri.auth:/oauth/mcp`. Los permisos son opcionales; sin selección explícita se usan los anunciados por el recurso. El navegador de autenticación pertenece a iOS. No se incluye un client secret ni se entrega una credencial al agente.

Se descubren metadatos de recurso y OAuth/OIDC, se vinculan recurso/emisor, se usa PKCE S256 y se comprueban estado, callback y emisor de respuesta cuando se anuncia. La renovación reserva una revisión durable antes de consumir el token; una respuesta incierta exige nueva autorización. Cambiar el destino o credencial invalida las herramientas ya revisadas.

Este acceso requiere que el proveedor admita un cliente nativo y su callback privado. No implementa todavía registro dinámico, documentos públicos de client ID, callbacks HTTPS universales ni autorización incremental automática. No se presenta como compatibilidad universal con todos los servidores OAuth MCP. La especificación MCP HTTP limita sus callbacks a HTTPS/localhost; esta ruta utiliza el perfil nativo de RFC 8252 cuando el proveedor lo admite. Referencias: [autorización MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) y [OAuth para apps nativas](https://www.rfc-editor.org/rfc/rfc8252).

Las pruebas de códigos, rotación, cancelación, UI y Keychain simulado no autorizan cuentas reales ni prueban SideStore.
