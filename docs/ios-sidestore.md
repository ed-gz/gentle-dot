# Capri en iPhone sin Mac ni membresía de pago

La ruta de fase 1 es **GitHub Actions/macOS → IPA sin firma → SideStore con Apple ID gratuito**. No hace falta la membresía Apple Developer de US$99/año para este uso personal. Sí hacen falta firma de desarrollo gratuita, emparejamiento USB inicial y renovar la firma antes de siete días. Esto no es distribución por App Store ni TestFlight.

## Obtener el IPA

1. En GitHub, abre **Actions → Capri unsigned iOS (SideStore) → Run workflow** en la rama que contiene este shell. No solicita certificados, equipo Apple ni secretos.
2. Descarga el artefacto `Capri-unsigned-iphone` y extrae `Capri-unsigned.ipa`. El ZIP exterior de Actions no es el IPA.
3. No intentes instalar ese IPA directamente con `ideviceinstaller`: aún no está firmado. SideStore lo firma para tu dispositivo.

El runner genera los iconos desde el SVG del shell y el proyecto Xcode mediante `cargo tauri ios init --ci`; `xcodebuild` compila para **iphoneos/arm64**, con ambas opciones de firma desactivadas. Se empaqueta `Payload/*.app` sin exportación de distribución. El icono PNG del shell desktop se referencia, sin modificarlo, para que `cargo check` en Linux también tenga un icono de contexto válido.

## Preparación única desde Linux

**No ejecutes estos pasos como parte de fase 1.** Esta es la guía para la futura instalación en un iPhone compatible; nunca subas un Apple ID, contraseña, archivo de pairing ni IPA ya firmado a CI.

1. Consulta primero las [instrucciones vigentes de SideStore](https://docs.sidestore.io/), incluida su compatibilidad con tu versión exacta de iOS. Usa las descargas oficiales. La interfaz, VPN y procedimiento de arranque pueden cambiar.
2. Conecta el iPhone por USB al equipo Linux, desbloquéalo y acepta **Confiar en este ordenador**. Necesitas acceso USB/usbmuxd; si usas herramientas de libimobiledevice, `idevicepair pair` permite comprobar el emparejamiento.
3. Descarga el binario Linux de **jitterbugpair** desde el proyecto enlazado por SideStore (históricamente [SideStore/Jitterbug](https://github.com/SideStore/Jitterbug)). Ejecuta `./jitterbugpair` con el iPhone desbloqueado y acepta los avisos de confianza. Guarda el `.mobiledevicepairing` generado como material privado: permite acceso al dispositivo. Transfiérelo al iPhone por un canal privado; no lo adjuntes a issues. Si la guía de tu versión sustituye jitterbugpair por otra herramienta de pairing, sigue esa guía.
4. Instala **SideStore primero**, no nuestro IPA. Una ruta Linux es [iLoader](https://github.com/nab138/iloader), siguiendo su opción SideStore y su documentación para Linux. Necesita el iPhone conectado y un Apple ID gratuito para firmar SideStore. Revisa la procedencia del instalador y sus requisitos de anisette/2FA antes de introducir credenciales. No uses un servicio web desconocido que pida tu contraseña. Si esa versión no admite tu iOS, detente: jitterbugpair por sí solo **no instala ni firma SideStore**.
5. En el iPhone, habilita **Modo de desarrollador** cuando iOS lo solicite (Ajustes → Privacidad y seguridad; requiere reinicio) y confía en tu perfil de desarrollador en Ajustes → General → VPN y gestión de dispositivos, si aparece.
6. Abre SideStore, importa el archivo de pairing y configura la VPN local exigida por **esa versión** siguiendo su guía oficial. Esa VPN permite la comunicación local de SideStore; no reemplaza tu conexión privada al daemon. Inicia sesión con tu Apple ID gratuito en SideStore.
7. Desde **My Apps / +** importa `Capri-unsigned.ipa`. SideStore lo vuelve a firmar y lo instala. Si SideStore cambia el identificador del paquete para tu cuenta, es normal. No hacen falta certificados en GitHub.
8. Haz una renovación manual de **SideStore y Capri** y confirma las fechas nuevas. Después habilita el refresco automático según la guía. Conserva una copia privada del pairing y un camino de recuperación Linux/USB.

## Primer arranque de Capri

- Carga desde Archivos tu `capri-full.png` personal de **240 × 420**, el recorte del flujo 2D actual de PC. No se distribuye arte personal o de terceros dentro del IPA. En fase 1 se selecciona de nuevo tras reiniciar la app; no hay importación persistente ni descarga de assets desde CI.
- El shell usa directamente `createEngine`, `RigDirector` y `RigFx` de `packages/ui/src/capri2d`, como dependencia del workspace. No importa el componente desktop que exige comandos Rust de assets, ni el flujo antiguo de sprites. Los cut-ins opcionales con imágenes no están incluidos; las animaciones de pose/shaders y FX procedurales sí se reutilizan.
- Introduce la URL **`wss://host/ws`** accesible desde el iPhone y el token del dispositivo obtenido por los mecanismos existentes del daemon. No se introduce el PIN web ni un enlace de invitación en lugar del token. No hay escáner/pairing de daemon en este shell mínimo.
- El certificado TLS debe ser de confianza para iOS; no hay excepciones ATS para tráfico inseguro. Una VPN/Tailscale, si la necesitas, debe coexistir con la VPN requerida por SideStore: verificarlo en el dispositivo. El daemon debe aceptar el origen del WebView Tauri; no se ha cambiado ninguna allowlist aquí.
- Se muestran hasta cuatro viñetas de historial/respuestas/avisos. No hay envío de mensajes, aprobaciones, voz, monitor Android ni servicio en segundo plano. La conexión se cierra al ocultar la app y se reconecta al volver; las credenciales sólo viven en memoria.

## Límites reales del Apple ID gratuito

| Límite | Consecuencia |
| --- | --- |
| Firma de siete días | Hay que renovar **ambas apps** antes de expirar. El refresco automático es best-effort: iOS puede suspenderlo; comprueba fechas y renueva manualmente. Si SideStore expira, usa otra vez el bootstrap USB/Linux. |
| Tres apps de desarrollo activas | SideStore suele ocupar una plaza: quedan dos, una para Capri. Extensiones y App IDs tienen límites adicionales; una cuenta gratuita suele permitir diez App IDs por siete días. |
| Sin distribución pública | No sirve para App Store/TestFlight. Los minutos macOS de GitHub pueden costar según plan/repositorio; “sin US$99/año” no significa infraestructura ilimitada gratuita. |
| Capacidades restringidas | No se solicitan push/APNs, app groups ni entitlements de pago. APNs de desarrollo, cuando está disponible con otro tipo de perfil, usa sandbox; la firma gratuita no habilita push por arte de magia. Este shell **no implementa push**, ni producción ni sandbox. |
| iOS suspende apps | Un WebSocket foreground no garantiza avisos con la pantalla bloqueada. No se prometen las capacidades del servicio Android. |
| Pairing/compatibilidad | Actualizar/restaurar iOS puede invalidar el pairing. Ninguna prueba en Linux confirma compatibilidad con iPhone 17e o su versión de iOS. |

## Decisión de generación y evidencia local

En este entorno Linux, `cargo tauri --version` y `cargo tauri ios init --help` fallan con **no such command: tauri**; tampoco hay `xcodebuild`. Por tanto, no se pudo comprobar offline si esta CLI puede generar el proyecto iOS sin Xcode. No se afirma haber observado esa restricción: la compilación nativa sí requiere el SDK de Apple.

Se eligió **estructurar un shell web independiente con las convenciones Vite de `apps/mobile` y generar el proyecto nativo en CI/macOS**, en lugar de escribir un `.xcodeproj` a mano o reutilizar el runtime Android/Capacitor. Tauri genera sus fases de enlace Rust y sus scripts Xcode; mantenerlos manualmente sería más frágil. La CLI del runner se fija a 2.8.4; el lock Rust registra la resolución offline disponible. No se ha ejecutado CI ni se ha instalado ninguna herramienta local.

Validación Linux:

```sh
node --test apps/ios/test/config.test.mjs
node_modules/.bin/tsc -p apps/ios/tsconfig.json --noEmit
CARGO_TARGET_DIR="$PWD/apps/ios/src-tauri/target" cargo check --offline --manifest-path apps/ios/src-tauri/Cargo.toml -j 4
```

Los tests parsean YAML con Ruby/Psych (fallback porque no hay actionlint), comprueban configuración/firma y validan sintaxis bash y rechazo temprano de Linux. No equivalen a actionlint ni a compilar Xcode.

**Pendiente en macOS/iPhone:** generación sin equipo Apple, compatibilidad entre CLI y crates resueltos, ejecución standalone de la fase `tauri ios xcode-script`, selección del scheme `_iOS`, embedding de `dist` en Release, validez del IPA, firma SideStore, origen/TLS del daemon, recuperación WebGL/WKWebView, safe areas/VoiceOver/Dynamic Type, consumo y refresco de siete días. Un workflow verde más una prueba real son necesarios antes de declarar instalable el IPA.

## Referencias de revisión

- [Tauri 2: requisitos](https://v2.tauri.app/start/prerequisites/) y [distribución iOS](https://v2.tauri.app/distribute/app-store/).
- [Apple: comparación de membresías](https://developer.apple.com/support/compare-memberships/) y [capacidades disponibles](https://developer.apple.com/help/account/reference/supported-capabilities-ios).
- [SideStore](https://sidestore.io/) y [documentación de instalación/refresco](https://docs.sidestore.io/).
- Patrón público solicitado: [OpenNutriTracker / ios_sideload.yml](https://github.com/simonoppowa/OpenNutriTracker/blob/main/.github/workflows/ios_sideload.yml): compilar sin firma → empaquetar Payload → subir artefacto. No se ha consultado su contenido en vivo en este entorno; no se atribuye equivalencia exacta ni se copian pasos de firma.

Estas referencias requieren comprobación actual antes de instalar; esta sesión sólo verificó herramientas y código disponibles offline.
