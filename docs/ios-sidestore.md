# Capri en iPhone sin Mac ni membresía de pago

La ruta es **GitHub Actions/macOS → IPA sin firma Apple → SideStore con Apple ID gratuito**. El empaquetador incorpora ahora sellos ad-hoc con los permisos de App Groups; SideStore sigue realizando la firma personal necesaria para instalar. Véase [verificación del empaquetado](ios-packaging.md). No hace falta la membresía Apple Developer de US$99/año para este uso personal. Sí hacen falta firma de desarrollo gratuita, emparejamiento USB inicial y renovar la firma antes de siete días. Esto no es distribución por App Store ni TestFlight.

**Estado al 28 de octubre de 2026:** fase 1 instalada y validada en iPhone; las entregas posteriores no están aceptadas por el usuario. El candidato personal `fe4370a` conserva el rig, arte, historial, sesiones y adjuntos anteriores; añade un compositor compacto, selector de Archivos de UIKit con recuperación durable, continuidad limitada del turno Apple al salir y OAuth público para servicios MCP adicionales. CI `40761902495` compiló app/extensión y verificó sellos/App Groups; la inspección independiente de la IPA también pasa. Falta instalar y comprobar esta entrega en el iPhone. El run histórico `40600744611` no valida los cambios nuevos. Continuar exclusivamente en `/home/egarza/gentle-dot-capri`. El [roadmap nativo](ios-native-roadmap.md) distingue implementación y aceptación; el [registro](../odd/tasks/capri-ios.md) conserva evidencia y fallos anteriores.

## Obtener el IPA

Entrega actual: [run privado 40761902495](https://github.com/ed-gz/capri-ios-personal/actions/runs/40761902495), fuente `fe4370a72481de89b3dc72dcb8cb48b6b0187275`, Xcode 26.3/SDK 26.2. Archivo local: `/home/egarza/gentle-dot-capri/.cache/ios-download/capri-personal-fe4370a.ipa`. [Descarga por Tailscale](https://egarza-dell.tailb707be.ts.net/ios/capri-personal-fe4370a.ipa), verificada byte a byte. Tamaño: 3 560 268 bytes; SHA-256 `7ca7e957540f843993dfaedde5c3d192f785af775e68278c07537e91815d7eee`. La versión interna continúa en 0.1.0; Ajustes muestra el commit de fuente. Los paquetes anteriores se conservan como históricos. La extensión finita de UIKit no garantiza ejecución indefinida, supervivencia a terminación ni aceptación nativa; el escáner QR en vivo posterior no está incluido en este SHA.

1. Para instalar el candidato ya construido, usa el archivo local o la descarga anterior. Para reconstruirlo, usa el workflow privado `ios-personal.yml` con un SHA de fuente publicado de 40 caracteres y el arte verificado, según [empaquetado personal](ios-personal-art.md). Los cambios sólo locales no se incluyen en Actions.
2. El artefacto privado se llama `Capri-personal-iphone-<SHA>` y contiene `Capri-unsigned.ipa`. El ZIP exterior de Actions no es el IPA. El workflow público genérico no incorpora el PNG personal.
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

- Carga desde Archivos tu `capri-full.png` personal de **240 × 420**, el recorte del flujo 2D actual de PC. No se distribuye arte personal dentro del IPA. La fase 1 requiere seleccionarlo tras reiniciar; el código de fase 2 lo conserva en IndexedDB, hasta 5 MiB. Esa persistencia requiere validación en la nueva IPA.
- El shell usa directamente `createEngine`, `RigDirector` y `RigFx` de `packages/ui/src/capri2d`, como dependencia del workspace. No importa el componente desktop que exige comandos Rust de assets, ni el flujo antiguo de sprites. Los cut-ins opcionales con imágenes no están incluidos; las animaciones de pose/shaders y FX procedurales sí se reutilizan.
- Introduce la URL **`wss://host/ws`** accesible desde el iPhone y el token del dispositivo obtenido por los mecanismos existentes del daemon. No se introduce el PIN web ni un enlace de invitación en lugar del token. El código nuevo permite emparejar un dispositivo desde Ajustes y conserva su credencial en Keychain; comprobar ese flujo en la nueva IPA.
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
