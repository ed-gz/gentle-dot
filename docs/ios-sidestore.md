# Capri en iPhone sin Mac ni membresía de pago

La ruta es **GitHub Actions/macOS → IPA sin firma Apple → SideStore con Apple ID gratuito**. El empaquetador incorpora ahora sellos ad-hoc con los permisos de App Groups; SideStore sigue realizando la firma personal necesaria para instalar. Véase [verificación del empaquetado](ios-packaging.md). No hace falta la membresía Apple Developer de US$99/año para este uso personal. Sí hacen falta firma de desarrollo gratuita, emparejamiento USB inicial y renovar la firma antes de siete días. Esto no es distribución por App Store ni TestFlight.

**Estado al 29 de octubre de 2026:** fase 1 validada antes en iPhone; las entregas posteriores aún requieren aceptación en dispositivo. La IPA personal más reciente es `0708699`, descrita abajo. La actividad refleja el último estado observado y queda obsoleta si pierde señal; no mantiene Capri ni la laptop ejecutándose. El proceso activo de la laptop anuncia la capacidad versionada de controles; aún no se ha probado desde el iPhone. Continuar en `/home/egarza/gentle-dot-capri`; el [roadmap](ios-native-roadmap.md) y el [registro](../odd/tasks/capri-ios.md) distinguen pruebas y aceptación.

## Obtener el IPA

Candidato actual para importar desde la PC: `/home/egarza/gentle-dot-capri/.cache/ios-download/capri-personal-0708699.ipa`. Fuente `07086994fea3dacc27c4bd37126dbefd4653208a`, run público [40936878173](https://github.com/ed-gz/gentle-dot/actions/runs/40936878173), 4.561.827 bytes, SHA-256 `841eb379837f280aa30e0f960483b3d6f732a51518cb18b3238051ae2d76ae3b`. Incluye el arte personal, Share y Live Activity; se verificó localmente tras transferirse cifrada, sin almacenar artefactos de Actions. SideStore debe firmarla y las extensiones, dictado, inferencia y presentación aún requieren prueba en el iPhone. Una consulta autenticada de sólo lectura confirmó que el daemon activo anuncia el protocolo de controles, pero no se han probado controles desde el iPhone. No se ha verificado una nueva ruta de descarga por Tailscale para este archivo.

Candidatos históricos: [run privado 40778422916](https://github.com/ed-gz/capri-ios-personal/actions/runs/40778422916), fuente `21621108b8ba70c3f3d6c6fb2fc8acd9eedc5d10`, y [run privado 40777162051](https://github.com/ed-gz/capri-ios-personal/actions/runs/40777162051), fuente `20aa9d5`. Sus archivos y enlaces anteriores no incluyen las correcciones del candidato actual. La versión interna continúa en 0.1.0; Ajustes muestra el commit de fuente.

1. Para instalar el candidato actual, importa el archivo indicado arriba desde la PC. Los cambios sólo locales no se incluyen en Actions.
2. El run actual no publicó un artefacto: el paquete se recuperó desde una salida cifrada y se verificó en la PC. El workflow público genérico no incorpora el PNG personal; los artefactos de runs privados anteriores contienen una IPA dentro de un ZIP exterior.
3. Importa el IPA en SideStore: todavía carece de la firma personal y el perfil que autorizan su instalación en tu dispositivo. Un sello ad-hoc no concede esa autorización.

El runner genera los iconos desde el SVG y el proyecto con `cargo tauri ios init --ci`; compila mediante **`cargo tauri ios build --target aarch64 --no-sign --ci`**. No sustituirlo por `xcodebuild` crudo: la fase Rust requiere el servidor de opciones que inicia Tauri; contexto: [tauri#13547](https://github.com/tauri-apps/tauri/issues/13547). La CLI 2.12.1 genera la IPA; el script propaga cualquier fallo y no busca productos residuales en Archives. Antes de publicar exige una IPA nueva, identidad Capri, plataforma iphoneos, arm64 en ambos ejecutables, enlaces nativos, firma ad-hoc verificada y App Groups leídos desde los bytes de ambos ejecutables. El [contrato del empaquetador](ios-packaging.md) describe los gates y la comprobación portable.

Para cada entrega, comprobar Xcode/SDK reales y el preflight de Foundation Models, Speech, Vision y los helpers nativos; `macos-15` por sí solo no garantiza el SDK. Registrar run, SHA y SHA-256 de la IPA antes de instalar. El comando de dispatch usado por esta rama es `gh workflow run ios-sideload.yml --repo ed-gz/gentle-dot --ref fix/android-capri-motion-mobile`.

## Preparación única desde Linux

El bootstrap ya se completó en fase 1 con iLoader 2.4.0 y SideStore. Repetirlo sólo si SideStore/pairing requieren recuperación; para una versión nueva de Capri normalmente basta importar la IPA. Nunca subir Apple ID, contraseña, pairing ni IPA firmada a CI.

1. Consulta primero las [instrucciones vigentes de SideStore](https://docs.sidestore.io/), incluida su compatibilidad con tu versión exacta de iOS. Usa las descargas oficiales. La interfaz, VPN y procedimiento de arranque pueden cambiar.
2. Conecta el iPhone por USB al equipo Linux, desbloquéalo y acepta **Confiar en este ordenador**. Necesitas acceso USB/usbmuxd; si usas herramientas de libimobiledevice, `idevicepair pair` permite comprobar el emparejamiento.
3. Descarga el binario Linux de **jitterbugpair** desde el proyecto enlazado por SideStore (históricamente [SideStore/Jitterbug](https://github.com/SideStore/Jitterbug)). Ejecuta `./jitterbugpair` con el iPhone desbloqueado y acepta los avisos de confianza. Guarda el `.mobiledevicepairing` generado como material privado: permite acceso al dispositivo. Transfiérelo al iPhone por un canal privado; no lo adjuntes a issues. Si la guía de tu versión sustituye jitterbugpair por otra herramienta de pairing, sigue esa guía.
4. Instala **SideStore primero**, no nuestro IPA. Una ruta Linux es [iLoader](https://github.com/nab138/iloader), siguiendo su opción SideStore y su documentación para Linux. Necesita el iPhone conectado y un Apple ID gratuito para firmar SideStore. Revisa la procedencia del instalador y sus requisitos de anisette/2FA antes de introducir credenciales. No uses un servicio web desconocido que pida tu contraseña. Si esa versión no admite tu iOS, detente: jitterbugpair por sí solo **no instala ni firma SideStore**.
5. En el iPhone, habilita **Modo de desarrollador** cuando iOS lo solicite (Ajustes → Privacidad y seguridad; requiere reinicio) y confía en tu perfil de desarrollador en Ajustes → General → VPN y gestión de dispositivos, si aparece.
6. Abre SideStore, importa el archivo de pairing y configura la VPN local exigida por **esa versión** siguiendo su guía oficial. Esa VPN permite la comunicación local de SideStore; no reemplaza tu conexión privada al daemon. Inicia sesión con tu Apple ID gratuito en SideStore.
7. Desde **My Apps / +** importa `Capri-unsigned.ipa`. SideStore lo vuelve a firmar y lo instala. Si SideStore cambia el identificador del paquete para tu cuenta, es normal. No hacen falta certificados en GitHub.
8. Haz una renovación manual de **SideStore y Capri** y confirma las fechas nuevas. Después habilita el refresco automático según la guía. Conserva una copia privada del pairing y un camino de recuperación Linux/USB.

## Primer arranque de Capri

- El paquete personal ya incluye tu Capri 2D original y la carga sin internet. No hay que importar una imagen para empezar. **Ajustes → Personaje y movimiento → Cambiar imagen** permite reemplazarla por un PNG personal de 240 × 420, hasta 5 MiB, conservado en IndexedDB. El workflow público genérico sigue sin incluir ese arte privado.
- El shell usa `createEngineAsync`, `RigDirector` y `RigFx` de `packages/ui/src/capri2d`, como dependencia del workspace. No importa el componente desktop que exige comandos Rust de assets, ni el flujo antiguo de sprites. Los cut-ins opcionales con imágenes no están incluidos; las animaciones de pose/shaders y FX procedurales sí se reutilizan.
- En la laptop, desde `/home/egarza/gentle-dot-capri`, ejecuta `pnpm mobile:connect` para mostrar el QR de vinculación del daemon existente. No copies el token maestro. El código es temporal y privado; si vence, genera otro. No hace falta instalar ni reconstruir Android.
- En **Ajustes → Tu laptop**, escanea la invitación QR emitida por Gentle Dot y revisa el equipo antes de pulsar Vincular. La credencial del dispositivo queda en Keychain. También se puede importar una foto del QR o pegar la invitación. **Conexión manual** conserva URL `wss://host/ws` y token como alternativa; no recibe el PIN web ni la invitación en el campo token. El recorrido con cámara y la persistencia tras firma SideStore requieren comprobación en el teléfono.
- El certificado TLS debe ser de confianza para iOS; no hay excepciones ATS para tráfico inseguro. Una VPN/Tailscale, si la necesitas, debe coexistir con la VPN requerida por SideStore: verificarlo en el dispositivo. El daemon debe aceptar el origen del WebView Tauri; no se ha cambiado ninguna allowlist aquí.
- La versión nueva centra la experiencia en una conversación con Capri: motor Apple con herramientas locales, motor conectado a Pi, archivo persistente, dictado local, OCR y conexiones externas configurables. La implementación y sus pruebas se detallan en el [roadmap](ios-native-roadmap.md); no equivalen a validación en el teléfono. El preview web no ejecuta Apple Intelligence. Las solicitudes del host se revisan en tarjetas vinculadas al contenido exacto; credenciales persistentes usan Keychain.
- Para reuniones, conservar **Notas de Voz → guardar en Archivos → importar en Capri** como alternativa operativa hasta validar el destino nativo Compartir y su App Group firmado por SideStore. El código de sincronización durable y procesamiento en Pi requiere un host actualizado y disponible. Guardar localmente no confirma transferencia; una minuta sólo se aprueba tras revisión de su evidencia y contenido.

## Límites reales del Apple ID gratuito

| Límite | Consecuencia |
| --- | --- |
| Firma de siete días | Hay que renovar **ambas apps** antes de expirar. El refresco automático es best-effort: iOS puede suspenderlo; comprueba fechas y renueva manualmente. Si SideStore expira, usa otra vez el bootstrap USB/Linux. |
| Tres apps de desarrollo activas | SideStore suele ocupar una plaza: quedan dos, una para Capri. Extensiones y App IDs tienen límites adicionales; una cuenta gratuita suele permitir diez App IDs por siete días. |
| Sin distribución pública | No sirve para App Store/TestFlight. Los minutos macOS de GitHub pueden costar según plan/repositorio; “sin US$99/año” no significa infraestructura ilimitada gratuita. |
| Capacidades y extensiones | No se solicita ni se presume APNs. El handoff informa App Groups entre las capacidades gratuitas de Apple; eso no demuestra que SideStore firme app y extensión manteniendo el grupo. La extensión y el resolver ya están escritos; probar importación real y renovación antes de declarar validado el flujo. |
| iOS suspende apps | Un WebSocket foreground no garantiza avisos con la pantalla bloqueada. No se prometen las capacidades del servicio Android. |
| Pairing/compatibilidad | Actualizar/restaurar iOS puede invalidar el pairing. Fase 1 tuvo prueba en iPhone 17e; ni esa prueba ni los tests Linux confirman compatibilidad de una nueva IPA, extensión o versión de iOS. |

## Validar cada entrega

La decisión original fue mantener un shell web/Vite separado y generar el proyecto nativo Tauri en CI/macOS. Los resultados de exploración inicial están en L1–L6 del registro y fueron seguidos por la validación real L7. No deben leerse como estado actual del teléfono ni de la CLI.

El workflow fija Tauri CLI 2.12.1 y selecciona Xcode estable >=26. La API JavaScript de iOS está fijada en 2.2.0 para coincidir con el minor del backend Rust; conservar esa compatibilidad al actualizar. Registrar también las versiones efectivas de Xcode/SDK del run. Compilar Rust en Linux no compila Swift/Foundation Models. Los tests de bridge y host usan fixtures y no demuestran inferencia Apple o una sesión real de Pi.

Las cifras **52/52 Node y 15/15 navegador** pertenecen a la entrega histórica `1ff5d38`. El [registro de trabajo](../odd/tasks/capri-ios.md) identifica los resultados posteriores por candidato; no reutilizar resultados antiguos como aceptación del código actual. La unidad nueva de empaquetado pasa **19/19 pruebas** con firmas simuladas en Linux; codesign real queda para CI macOS. El bloqueo de escritura Git quedó resuelto el 27 de octubre al aplicarse el perfil de acceso completo; no queda autorización pendiente.

Validación Linux:

```sh
node --test apps/ios/test/*.test.mjs
node_modules/.bin/tsc -p apps/ios/tsconfig.json --noEmit
pnpm --filter @gentle-dot/ios build
CARGO_TARGET_DIR="$PWD/apps/ios/src-tauri/target" cargo check --offline --locked --manifest-path apps/ios/src-tauri/Cargo.toml -j 4
CARGO_TARGET_DIR="$PWD/apps/ios/src-tauri/target" cargo test --offline --locked --manifest-path apps/ios/src-tauri/Cargo.toml -p tauri-plugin-local-intelligence --lib -j 4
CAPRI_BROWSER_PATH=/home/egarza/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell node_modules/.bin/playwright test -c playwright.ios.config.ts
```

El path de Chromium es el runtime del handoff; ajustarlo si cambia. Verificar Vite/puerto antes de reutilizar o detener un proceso. Los tests de configuración usan Ruby/Psych y comprueban sintaxis bash/firma; no equivalen a compilar Xcode. Registrar todos los resultados actuales, incluidos fallos y casos no alcanzados.

**Aceptación de fase 2 en iPhone:** comprobar al menos dos turnos Apple en modo avión, Wi-Fi apagado, sin token y laptop apagada; cancelar, bloquear y volver. Después enlazar Pi y cambiar de motor manteniendo el hilo. Verificar recuperación de arte/borrador/archivos/versiones, teclado/safe areas, VoiceOver/texto grande, pequeño/landscape, movimiento reducido, WebGL, memoria/consumo y suspensión. Renovar SideStore y Capri comprobando la fecha efectiva. CI verde y fixtures no cierran estos escenarios.

## Soluciones heredadas

| Caso | Solución observada en fase 1 |
| --- | --- |
| GrandSlam/iLoader `-22406` | La contraseña de aplicación no sirvió; se usó contraseña real de Apple ID y 2FA dentro de la herramienta |
| iLoader `-80045 "to unknown"` | `idevicepair pair` con teléfono desbloqueado |
| AppImage negro en Hyprland | Binario extraído del paquete nativo por el problema EGL/WebKitGTK |
| Pantalla blanca al descargar | Tailscale Serve sólo sirve las rutas configuradas; otras pueden llegar al daemon |

Binario heredado: `.cache/ios-setup/iloader-x/usr/bin/iloader`. Entorno usado: `GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1`.

Descargas heredadas: Python en 4319 con raíz `.cache/ios-download/`, expuesto como `/ios`; `/` apuntaba al daemon 4317 y `/descargas/gentle-dot.apk` a 4318. Comprobar procesos/configuración antes de usar; no reiniciar desktop como efecto de compilar iOS. El PNG personal está en `.cache/ios-download/capri-full.png`. Nunca ampliar una raíz de descarga para incluir tokens, pairing o credenciales.

## Referencias de revisión

- [Tauri 2: requisitos](https://v2.tauri.app/start/prerequisites/) y [distribución iOS](https://v2.tauri.app/distribute/app-store/).
- [Apple: comparación de membresías](https://developer.apple.com/support/compare-memberships/) y [capacidades disponibles](https://developer.apple.com/help/account/reference/supported-capabilities-ios).
- [SideStore](https://sidestore.io/) y [documentación de instalación/refresco](https://docs.sidestore.io/).
- [Apple: compartir datos entre app y extensión](https://developer.apple.com/documentation/technologyoverviews/shared-data) y [Tauri: plugins móviles](https://v2.tauri.app/develop/plugins/develop-mobile/).

Revisar compatibilidad de SideStore/iLoader con la versión real de iOS antes de una nueva instalación. La evidencia de la fase 1 se conserva como histórica; la aceptación nueva se registra por SHA, IPA y dispositivo.

## Paso local al salir de Capri

La opción «Intentar continuar el análisis al salir» está desactivada por defecto y sólo afecta a mensajes posteriores. Si se activa, Capri intenta usar `BGContinuedProcessingTask` para el primer paso del modelo iniciado con ese mensaje. El inicio puede tardar hasta 2,5 segundos mientras se espera al sistema y iOS puede mostrar su actividad. Si no concede el trabajo o la configuración del paquete no coincide con el identificador firmado, se conserva el lease UIKit breve. Las inferencias siguientes y las herramientas siguen esperando a que la app esté en primer plano.

El estado del sistema corresponde a un **paso de análisis**, no a la solicitud completa. Una decisión válida de herramienta termina ese paso, pero no está guardada en el diario nativo: si la app muere antes de continuar, la solicitud se recupera como interrumpida y la herramienta no se repite. La respuesta final sí se conserva en el diario antes de confirmar su recuperación. No se inventa avance durante la inferencia; iOS puede cancelar el trabajo por falta de progreso, condiciones del dispositivo o acción del usuario. El cierre forzado de la app también cancela las tareas del sistema.

Se configura un identificador con el bundle del build y un sufijo por ejecución, más el modo de procesamiento; no se solicitan entitlements GPU ni Neural Engine. El código comprueba que el identificador permitido todavía corresponda al bundle instalado, porque SideStore podría reescribirlo. La ruta de firma gratuita y el funcionamiento de Foundation Models en background necesitan una prueba física; compilar o verificar el IPA anterior a la firma no los demuestra. iOS 27 restringe el acceso al Neural Engine en background mediante un entitlement, pero no se ha establecido si el modelo del sistema de Foundation Models lo necesita en esta app. Fuentes: [tareas prolongadas de Apple](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados), [Foundation Models y límite en background](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/streamresponse(to:options:contextoptions:metadata:)) y [Background Inference](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.background-tasks.continued-processing.inference).
