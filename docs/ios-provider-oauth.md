# Autorización directa de proveedores desde Capri iOS

provider-oauth.ts implementa autenticación pública para Slack, Gmail y GitHub. provider-oauth-store.ts conserva credenciales en Keychain y renueva tokens con revisión atómica. **Estos servicios no se registran como herramientas del modelo y sus secretos nunca se incluyen en conversación, trazas o errores.**

**Validación:** pruebas de flujo, PKCE, cancelación, CAS y recuperación con transportes controlados. Todavía no se ha autorizado una cuenta real mediante estos módulos ni validado un callback en iPhone. Ajustes incluye la configuración por proveedor; los client IDs reales deben pertenecer a apps registradas por el usuario y el callback de Google debe estar incluido en la IPA.

## Contrato

| API | Resultado y obligación del caller |
| --- | --- |
| authorizeProviderAndSave(input, config, signal, presentDevice?, expectedRevision?) | Abre la autorización por ASWebAuthenticationSession o presenta el código GitHub. Devuelve sólo metadatos tras guardar en Keychain y confirmar CAS. |
| getValidProviderAccess(connectionId, signal?) | Devuelve connection y accessToken sólo al adaptador HTTP. La revisión puede cambiar después de renovar. |
| createProviderOAuth / createProviderOAuthStore | Servicios inyectables para pruebas. No añadir al catálogo del agente. |

Los endpoints de metadatos son https://api.github.com/, https://slack.com/api/ y https://gmail.googleapis.com/. Los adaptadores añaden sus rutas. Estas credenciales no se aceptan para otro destino, dominio empresarial o URL de token configurable.

connection-settings.ts monta un único formulario en Ajustes con selector MCP, GitHub, Slack, Gmail u Odoo. Ofrece token personal o device flow para GitHub, PKCE para Slack y Google, y API key para Odoo. Los campos de servidor, base de datos y UID sólo aparecen cuando corresponden. El modo anterior de Odoo exige base y UID; JSON-2 admite base opcional. Editar o retirar una conexión usa la revisión visible para impedir que una pantalla vieja sobrescriba credenciales nuevas.

El formulario comienza con permisos de consulta. Enviar mensajes o modificar repositorios se habilita mediante una elección explícita; el scope repo necesario para repositorios privados de GitHub concede lectura y escritura y se describe así. MCP y API keys conservan los permisos concedidos al crearlos en el proveedor. Cada acción externa mantiene su aprobación individual en la conversación.

La configuración manual guardada se presenta como acceso pendiente de comprobar al usarlo. La lista no afirma haber consultado la cuenta. Antes de quitarla muestra su nombre y aclara que borrar la credencial local no la revoca en el proveedor. Los tokens no se rellenan en el formulario al editar; sólo se recuperan los campos públicos OAuth necesarios.

El adaptador obtiene acceso **antes** de presentar una acción sensible y vincula la aprobación a la revisión devuelta. Después comprueba otra vez revisión y contenido. Autorizar OAuth concede acceso a una cuenta; no aprueba anticipadamente enviar comunicaciones ni modificar información.

## Configuración por proveedor

### Slack

Usar una app Slack pública con PKCE habilitado y callback exacto capri-auth://oauth/slack. Registrar el esquema capri-auth en la app iOS. Los permisos se solicitan en user_scope; los redirects personalizados no admiten scopes de bot.

El flujo genera verifier y state independientes mediante aleatoriedad nativa, usa S256 en Base64URL y valida el callback completo. El intercambio no lleva client secret. Slack emite credenciales rotatorias para estos redirects: conservar cada refresh token nuevo; los refresh tokens de apps PKCE vencen a los 30 días. [PKCE Slack](https://docs.slack.dev/authentication/using-pkce/), [rotación Slack](https://docs.slack.dev/authentication/using-token-rotation/).

### Gmail / Google iOS

Usar un OAuth client ID **de tipo iOS** asociado al bundle Capri. Su callback utiliza el client ID invertido: por ejemplo com.googleusercontent.apps.IDENTIFICADOR:/oauth2redirect/google. Registrar ese esquema en el Info.plist de la compilación; un client ID distinto puede requerir generar otra IPA.

El flujo usa PKCE, acceso offline y consentimiento explícito, sin client secret. Elegir sólo los scopes Gmail necesarios. No usar un cliente desktop ni loopback como sustituto del cliente iOS. [Configuración oficial iOS](https://developers.google.com/identity/sign-in/ios/start-integrating), [ejemplo AppAuth para Google iOS](https://github.com/openid/AppAuth-iOS/blob/master/Examples/README-Google.md).

### GitHub

Habilitar device flow en la app GitHub y proporcionar su client ID público. El caller presenta userCode, el enlace oficial https://github.com/login/device y vencimiento. El device_code secreto permanece dentro del flujo.

El polling respeta el intervalo y aumenta cinco segundos ante slow_down. Cancelación o vencimiento detienen nuevos intentos. Se admiten tokens con o sin expiración. El web application flow sigue requiriendo client secret aunque incluya PKCE; por eso Capri usa device flow, cuyo intercambio y renovación no requieren incrustarlo. [Autorización GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

El enlace oficial se abre mediante UIApplication sólo cuando el usuario pulsa el botón. Abrir Safari para autorizar no debe cancelar automáticamente el device flow al ocultarse Capri; iOS puede suspender el polling hasta volver. Cancelar explícitamente elimina el código visible, descarta respuestas tardías y detiene nuevos intentos.

## Persistencia y fallos inciertos

Las credenciales completas viven en el scope external-connections de Keychain, en una cuenta UUID distinta por escritura. IndexedDB conserva sólo metadatos y credentialAccount. saveConnectionCredentials confirma con CAS, descarta una credencial nueva si falla el commit y limpia la anterior después de confirmarlo.

La renovación sigue esta secuencia:

1. Leer conexión y credencial; comprobar proveedor, destino, vigencia y estado.
2. Usar el token si conserva más de 60 segundos de vigencia.
3. Reservar por CAS una revisión con refreshState igual a refreshing **antes** de contactar al proveedor.
4. Enviar un único refresh y guardar sus credenciales nuevas como ready.
5. Ante fallo de red o persistencia, dejar uncertain o la reserva refreshing y requerir autorización nueva.

Las llamadas concurrentes comparten una promesa; otra ventana no puede reservar la misma revisión. Tras un cierre inesperado, refreshing nunca significa éxito ni permite repetir un token posiblemente consumido. Si se cancela al caller después de comenzar el refresh, se termina de guardar el token rotado antes de rechazar la operación: la cancelación no pierde la única credencial válida.

No se promete renovación indefinida en background. Se comprueba acceso cuando una integración lo necesita. Revocación, vencimiento del refresh o un resultado incierto requieren nueva autorización visible.

## Verificación

    node --test apps/ios/test/provider-oauth.test.mjs

Pruebas: vector S256, callbacks falsificados, scopes prohibidos, ausencia de client secret, polling, cancelación tardía, CAS entre servicios, persistencia después de cancelar y recuperación sin replay.

connection-settings.spec.ts verifica con un bridge controlado: Keychain sin secretos en metadatos/UI, edición obsoleta rechazada, scopes iniciales mínimos, callback Google ausente bloqueado antes de abrir OAuth, apertura de GitHub por tap, cancelación tardía, campos Odoo, eliminación local explícita y layout a 375 px/landscape con texto al 200% y movimiento reducido. Los helpers nativos registeredURLSchemes y openExternalURL no se exponen al modelo.

Antes de declarar la conexión operativa, validar en iPhone callbacks y permisos reales, una renovación por proveedor, revocación, bloqueo/background y cierre durante refresh. Las cuentas conectadas a Codex no autentican automáticamente a Capri.
