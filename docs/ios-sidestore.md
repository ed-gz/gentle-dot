# Capri en iPhone sin Mac ni membresía de pago

La ruta de fase 1 es **GitHub Actions/macOS → IPA sin firma → SideStore con Apple ID gratuito**. No hace falta la membresía Apple Developer de US$99/año para este uso personal. Sí hacen falta firma de desarrollo gratuita, emparejamiento USB inicial y renovar la firma antes de siete días. Esto no es distribución por App Store ni TestFlight.

**Estado al 27 de octubre de 2026:** fase 1 instalada y validada en iPhone; código de fase 2 confirmado y publicado en `1ff5d38`, pendiente de aceptación nativa, instalación y prueba offline. El run histórico `40600744611` no valida los cambios nuevos. Continuar exclusivamente en `/home/egarza/gentle-dot-capri`. El [roadmap nativo](ios-native-roadmap.md) detalla el alcance completo y los gates; el [registro](../odd/tasks/capri-ios.md) conserva la evidencia y el seguimiento de CI.

## Obtener el IPA

1. Confirma el SHA publicado de `fix/android-capri-motion-mobile`: Actions no compila cambios que sólo existen localmente. En GitHub, abre **Actions → Capri unsigned iOS (SideStore) → Run workflow** y selecciona esa rama. El workflow debe existir en la rama por defecto para poder despacharse sobre la rama de trabajo. No solicita certificados, equipo Apple ni secretos.
2. Descarga el artefacto `Capri-unsigned-iphone` y extrae `Capri-unsigned.ipa`. El ZIP exterior de Actions no es el IPA.
3. No intentes instalar ese IPA directamente con `ideviceinstaller`: aún no está firmado. SideStore lo firma para tu dispositivo.

El runner genera los iconos desde el SVG y el proyecto con `cargo tauri ios init --ci`; compila mediante **`cargo tauri ios build --target aarch64 --no-sign --ci`**. No sustituirlo por `xcodebuild` crudo: la fase Rust requiere el servidor de opciones que inicia Tauri; contexto: [tauri#13547](https://github.com/tauri-apps/tauri/issues/13547). La CLI 2.12.1 genera la IPA; el script propaga cualquier fallo y no busca productos residuales en Archives. Antes de publicar exige una IPA nueva del build, identidad Capri, plataforma iphoneos, arquitectura arm64 y enlace con FoundationModels.

Para fase 2, comprobar Xcode/SDK reales y el gate de importación de Foundation Models; `macos-15` por sí solo no garantiza el SDK. Registrar run, SHA y SHA-256 de la IPA antes de instalar. El comando de dispatch usado por esta rama es `gh workflow run ios-sideload.yml --repo ed-gz/gentle-dot --ref fix/android-capri-motion-mobile`.

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
- Introduce la URL **`wss://host/ws`** accesible desde el iPhone y el token del dispositivo obtenido por los mecanismos existentes del daemon. No se introduce el PIN web ni un enlace de invitación en lugar del token. No hay escáner/pairing de daemon en este shell mínimo.
- El certificado TLS debe ser de confianza para iOS; no hay excepciones ATS para tráfico inseguro. Una VPN/Tailscale, si la necesitas, debe coexistir con la VPN requerida por SideStore: verificarlo en el dispositivo. El daemon debe aceptar el origen del WebView Tauri; no se ha cambiado ninguna allowlist aquí.
- La fase 1 muestra hasta cuatro viñetas. La fase 2 añade composer, conversación persistente, selector de motor y bandeja local. El preview web no ejecuta el modelo Apple; la app nativa debe comprobar su disponibilidad. Voz, Vision, conectores, sincronización y Share Extension siguen pendientes. Las autorizaciones del host se revisan todavía en laptop. La conexión se cierra al ocultar y vuelve al regresar; el token sólo vive en memoria.
- Para reuniones, hoy se usa **Notas de Voz → guardar en Archivos → importar en Trabajos**. Guardar un trabajo no confirma transferencia al host. No hay aún destino Capri en Compartir ni generación de minutas.

## Límites reales del Apple ID gratuito

| Límite | Consecuencia |
| --- | --- |
| Firma de siete días | Hay que renovar **ambas apps** antes de expirar. El refresco automático es best-effort: iOS puede suspenderlo; comprueba fechas y renueva manualmente. Si SideStore expira, usa otra vez el bootstrap USB/Linux. |
| Tres apps de desarrollo activas | SideStore suele ocupar una plaza: quedan dos, una para Capri. Extensiones y App IDs tienen límites adicionales; una cuenta gratuita suele permitir diez App IDs por siete días. |
| Sin distribución pública | No sirve para App Store/TestFlight. Los minutos macOS de GitHub pueden costar según plan/repositorio; “sin US$99/año” no significa infraestructura ilimitada gratuita. |
| Capacidades y extensiones | No se solicita ni se presume APNs. El handoff informa App Groups entre las capacidades gratuitas de Apple; eso no demuestra que SideStore firme app y extensión manteniendo el grupo. Probar una Share Extension mínima y su renovación antes de construir el flujo alrededor de ella. |
| iOS suspende apps | Un WebSocket foreground no garantiza avisos con la pantalla bloqueada. No se prometen las capacidades del servicio Android. |
| Pairing/compatibilidad | Actualizar/restaurar iOS puede invalidar el pairing. Fase 1 tuvo prueba en iPhone 17e; ni esa prueba ni los tests Linux confirman compatibilidad de una nueva IPA, extensión o versión de iOS. |

## Validar cada entrega

La decisión original fue mantener un shell web/Vite separado y generar el proyecto nativo Tauri en CI/macOS. Los resultados de exploración inicial están en L1–L6 del registro y fueron seguidos por la validación real L7. No deben leerse como estado actual del teléfono ni de la CLI.

El workflow fija Tauri CLI 2.12.1 y selecciona Xcode estable >=26. La API JavaScript de iOS está fijada en 2.2.0 para coincidir con el minor del backend Rust; conservar esa compatibilidad al actualizar. Registrar también las versiones efectivas de Xcode/SDK del run. Compilar Rust en Linux no compila Swift/Foundation Models. Los tests de bridge y host usan fixtures y no demuestran inferencia Apple o una sesión real de Pi.

Verificación local de esta entrega: **52/52 pruebas Node, 15/15 navegador, 2/2 Rust, TypeScript y build de producción**. La última repetición del navegador con API 2.2.0 terminó en 34.1 s. El bloqueo de escritura Git quedó resuelto el 27 de octubre al aplicarse el perfil de acceso completo; no queda autorización pendiente.

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
