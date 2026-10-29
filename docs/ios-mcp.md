# Conexiones MCP de Capri iOS

Capri puede descubrir herramientas de un servidor MCP remoto configurado por el
usuario. No hay una lista fija de proveedores. El endpoint usa HTTPS; la credencial
Bearer opcional se guarda en Keychain y nunca se entrega al modelo. También se puede autorizar un cliente OAuth público nativo previamente registrado por el servicio. Los servicios
deben ofrecer Streamable HTTP y negociar MCP `2025-11-25`, `2025-06-18` o `2025-03-26`;
la fuente también incluye una ruta experimental limitada para `2026-07-28`.
Las respuestas JSON o SSE deben terminar dentro de 30 segundos y 2 MiB. Esto requiere
internet; no depende de la PC.

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

El cliente propone `2025-11-25` al inicializar. Acepta una contraoferta
`2025-06-18` o `2025-03-26` y usa exclusivamente la versión negociada en los encabezados de la
notificación y todas las solicitudes posteriores. Si el servidor ofrece otra
versión, no envía la notificación de inicialización ni consultas o llamadas a
herramientas. No reintenta la inicialización en respuesta a errores HTTP genéricos.
La fuente incluye además una ruta experimental acotada para servidores sólo
`2026-07-28`; sus límites y pruebas se detallan más abajo.

Para admitir `2026-07-28` se necesita otro transporte lógico: la versión y las
capacidades viajan en `_meta` en cada solicitud y también se reflejan en HTTP;
el servidor ofrece `server/discover`, y esa revisión ya no usa el handshake ni
`Mcp-Session-Id`. La implementación deberá detectar de forma explícita qué familia
usa el servidor, procesar sus errores y mensajes multivuelta sin ejecutar peticiones
inesperadas, conservar revisión humana y journal durable, y no repetir mutaciones
cuya entrega sea incierta. Sus requisitos de autorización también necesitan una
revisión propia. No basta cambiar el número de versión. Referencias: [versionado
2026](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[transporte](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
y [versiones del SDK oficial](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

La evaluación de compatibilidad de `2026-07-28` debe comprobar, como mínimo:

1. Descubrimiento inocuo `server/discover` con `_meta` de versión y capacidades; detectar errores JSON-RPC modernos en HTTP 400 antes de intentar el handshake anterior. Ningún `tools/call` se usa para detectar versiones ni se repite automáticamente tras un error incierto.
2. Solicitudes modernas sin sesión, con `MCP-Protocol-Version` y `Mcp-Method`; `tools/call` también exige `Mcp-Name`. Los parámetros anotados con `x-mcp-header` requieren cabeceras `Mcp-Param-*` validadas y codificadas según el transporte, con correspondencia exacta entre cuerpo y cabeceras.
3. `resultType` y solicitudes de varias rondas: no tratar `input_required` como éxito. Mientras no exista una interacción revisable para elicitación y demás capacidades, rechazarla de forma explícita; un eventual siguiente paso debe vincular la aprobación al contenido completo y conservar la evidencia sin reejecutar una operación incierta.
4. Compatibilidad anterior: servidor dual con versión moderna, servidor sólo moderno, servidor 2025, error `UnsupportedProtocolVersion`, discrepancia de cabeceras, ausencia de capacidad y 401 OAuth deben probarse por separado; un error moderno reconocido no habilita un downgrade silencioso. OAuth debe revisarse independientemente y no requiere credenciales para los fixtures.
5. La especificación exige JSON Schema 2020-12 completo; Capri sólo implementa un subconjunto y rechaza restricciones que no puede evaluar. Ampliarlo y probarlo contra casos oficiales es requisito para afirmar conformidad completa. Referencias: [mensajes y esquema](https://modelcontextprotocol.io/specification/2026-07-28/basic), [cabeceras y retrocompatibilidad HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [herramientas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) y [autorización](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

La ruta experimental intenta primero el handshake 2025 para preservar los
servidores existentes. Sólo ante ciertos errores HTTP 400 correlacionados prueba
`server/discover`; si éste confirma `2026-07-28`, usa solicitudes sin sesión con
`_meta` y cabeceras modernas. Un servidor dual que acepte 2025 permanece en ese
protocolo. Un error ambiguo no provoca cambio de protocolo y una contraoferta
moderna `-32022` no se elige ni reintenta automáticamente. Es una política
conservadora: puede no conectar con servidores modernos que rechacen el handshake
de otra forma.

La ruta experimental conserva aprobación, revisión del catálogo y journal de
la llamada. Un resultado moderno `input_required`, desconocido o sin discriminador
queda incierto tras la ejecución y no se repite automáticamente. La prueba
opcional `bash apps/ios/scripts/check-official-mcp-sdk.sh` instala el SDK oficial
2.4.0 y Zod 4.6.7 en un directorio temporal con el lockfile específico de la
fixture y scripts desactivados; usa su servidor moderno en el mismo proceso
con datos sintéticos; comprueba rechazo de aprobación, una ejecución y journal.
No prueba URLSession, OAuth, TLS ni el iPhone. Un fixture adicional comprueba el
desafío OAuth de un servidor sólo moderno después de un rechazo correlacionado;
no autoriza una cuenta real. Para `x-mcp-header`, la ruta moderna valida nombres
y rutas estáticas, codifica los valores según la especificación, sólo genera
cabeceras `Mcp-Param-*` y muestra los valores derivados en la aprobación exacta.
La prueba del SDK oficial incluye un valor no ASCII. Se rechazan anotaciones
inválidas y se conservan límites adicionales de cabeceras y esquemas. Persisten
otras limitaciones de la ruta y no se afirma conformidad MCP 2026 completa.

La prueba `mcp-oauth-network.test.mjs` usa un servidor sintético en loopback que
comprueba PKCE S256 y `resource`, devuelve una redirección de callback de prueba
y rota el token sintético. También verifica cancelación, callbacks manipulados,
cambio concurrente de conexión y respuesta de renovación perdida sin reenvío.
El navegador de autenticación se simula: esto no valida `ASWebAuthenticationSession`,
Keychain, TLS, la cuenta de un proveedor ni la firma en el iPhone.

El descubrimiento admite hasta 64 herramientas, diez páginas y 512 KiB de catálogo.
Cada esquema individual puede ocupar 16 KiB. Se validan tipos, propiedades,
obligatorios, referencias locales, combinaciones, enumeraciones, constantes y
límites de números, textos y arreglos. Se admite el dialecto predeterminado
2020-12 o su identificador explícito; otros dialectos, identificadores de recurso
`$id`, restricciones malformadas y palabras no implementadas —por ejemplo
patrones regulares o referencias externas— producen un error explícito
antes de ejecutar. No se ignoran para fingir compatibilidad.

Cada llamada solicita una revisión humana dentro de la conversación, incluso si el
servidor la anuncia como lectura. La revisión contiene endpoint, revisión de
conexión, nombre remoto, esquema y argumentos exactos. Después de la aprobación se
reconsulta el catálogo y se compara el esquema de entrada, el esquema de salida,
la modalidad de ejecución, la descripción y la configuración. Un
cambio invalida la aprobación. Los tokens nunca forman parte de esa revisión.
Una herramienta que declara ejecución obligatoria mediante tareas asíncronas
se muestra como no compatible al intentar usarla, antes de pedir aprobación o
ejecutarla. Capri aún no implementa tareas MCP. Si cambia esa modalidad durante la
revisión, se invalida la aprobación anterior.

El cliente no anuncia sampling, raíces ni elicitación; no ejecuta solicitudes que
envíe el servidor. Los resultados se marcan como datos no confiables. Los enlaces y
recursos devueltos no se abren automáticamente. Se rechazan redirecciones HTTP y
respuestas JSON-RPC no correlacionadas o duplicadas. Los SSE se procesan sólo cuando
la respuesta finita termina; no se mantiene un canal de escucha permanente.

Los resultados estructurados se conservan exactamente, incluso si `content` es un
arreglo vacío. Cuando la herramienta declara `outputSchema`, Capri valida el objeto
estructurado contra el subconjunto de JSON Schema descrito arriba y comunica
`outputValidation`: `valid`, `unverified` o `not_declared`. Una salida que no cumple
el esquema o utiliza restricciones no admitidas se marca `unverified`; el recibo
correlacionado se conserva como respuesta del servidor, sin repetir la operación.
La validación no convierte el contenido externo en datos confiables ni demuestra que
una operación de negocio tuvo éxito.

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

Las pruebas Node verifican negociación de ambas versiones, rechazo de versiones
desconocidas, sesiones, paginación, validación,
aprobaciones, cambios durante revisión y fallos sin replay. Cuatro pruebas de
navegador verifican transacciones reales de IndexedDB, concurrencia, restauración
y migración de un journal versión 1. Cambiar esquema o credenciales mantiene el
bloqueo; argumentos distintos siguen creando una operación nueva revisable.
Son fixtures de protocolo, no evidencia de autenticación contra un proveedor real
ni de ejecución de URLSession en el iPhone instalado.

Referencias de protocolo: [negociación MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [herramientas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) y [tareas](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks).

## OAuth de otros servicios

En Ajustes → Conexiones → MCP remoto, el acceso «Autorizar cuenta» usa el client ID público del servicio. El callback nativo es `dev.gentledot.capri.auth:/oauth/mcp`. Los permisos son opcionales; sin selección explícita se usan los anunciados por el recurso. El navegador de autenticación pertenece a iOS. No se incluye un client secret ni se entrega una credencial al agente.

Se descubren metadatos de recurso y OAuth/OIDC, se vinculan recurso/emisor, se usa PKCE S256 y se comprueban estado, callback y emisor de respuesta cuando se anuncia. La renovación reserva una revisión durable antes de consumir el token; una respuesta incierta exige nueva autorización. Cambiar el destino o credencial invalida las herramientas ya revisadas.

Este acceso requiere que el proveedor admita un cliente nativo y su callback privado. No implementa todavía registro dinámico, documentos públicos de client ID, callbacks HTTPS universales ni autorización incremental automática. No se presenta como compatibilidad universal con todos los servidores OAuth MCP. La especificación MCP HTTP limita sus callbacks a HTTPS/localhost; esta ruta utiliza el perfil nativo de RFC 8252 cuando el proveedor lo admite. Referencias: [autorización MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) y [OAuth para apps nativas](https://www.rfc-editor.org/rfc/rfc8252).

Las pruebas de códigos, rotación, cancelación, UI y Keychain simulado no autorizan cuentas reales ni prueban SideStore.
