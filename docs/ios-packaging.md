# IPA de Capri: permisos embebidos y firma personal

El artefacto conserva el nombre `Capri-unsigned.ipa` para SideStore. El empaquetador ahora añade **sellos ad-hoc** a Capri y a su Share Extension para incluir sus entitlements reales. No usa certificado Apple, provisioning profile, cuenta ni contraseña en CI. SideStore debe volver a firmar ambos componentes para el dispositivo antes de instalarlos.

Esto soluciona una omisión demostrada en la IPA del [run 40634400355](https://github.com/ed-gz/gentle-dot/actions/runs/40634400355): sus dos ejecutables arm64 no tenían `LC_CODE_SIGNATURE`. Declarar `CapriAppGroup` en Info.plist y generar archivos `.entitlements` no había incorporado esos permisos al binario, porque Xcode compilaba con `CODE_SIGNING_ALLOWED=NO`. Apple documenta la firma del ejecutable como destino de los entitlements que comprueba el sistema. [TN2415](https://developer.apple.com/library/archive/technotes/tn2415/_index.html)

La IPA inspeccionada mide 2 254 373 bytes y tiene SHA-256 `87005776433c862eaafb427349ca121c26d8645f04d266a6b26e83628d41e0cd`. Su compilación nativa es evidencia válida del código de ese run; **no valida App Groups ni Compartir en el iPhone**. El run 40635768334 comenzó antes de esta corrección. La firma ad-hoc nueva requiere un run posterior y prueba con SideStore.

## Qué verifica el empaquetador

[`build-unsigned.sh`](../apps/ios/scripts/build-unsigned.sh) realiza estos pasos en macOS:

1. Borra la salida publicada anterior y exige exactamente una IPA recién generada por `cargo tauri ios build --target aarch64 --no-sign --ci -- --locked`. Cualquier error interrumpe la publicación.
2. Comprueba identidad Capri, plataforma iPhone, app y una Share Extension, propósito de micrófono, grupo configurado, ejecutables arm64 y enlace de la app con FoundationModels, Speech y Vision. Rechaza ZIP corrupto, rutas duplicadas/inseguras y enlaces simbólicos.
3. Lee `entitlements.path` de los targets reales del `project.yml` generado. Ambos plists deben declarar exactamente el grupo configurado; no adivina nombres de producto ni inventa permisos.
4. Sella primero la extensión y después la app con `codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements …`. Verifica cada firma con `codesign --verify --strict` y compara todos los entitlements extraídos contra sus fuentes.
5. Genera un ZIP candidato y vuelve a inspeccionar sus ejecutables, leyendo `LC_CODE_SIGNATURE`, el SuperBlob y el slot XML de entitlements. Ambos deben contener `com.apple.security.application-groups = [group.dev.gentledot.capri]`, o el grupo explícito del build.
6. Publica `out/Capri-unsigned.ipa` únicamente después de todas las comprobaciones y muestra su SHA-256. Fallos de firma, verificación o ZIP no dejan un resultado previo aparentando ser nuevo.

El sello ad-hoc conserva XML y solicita también DER. El lector de App Groups de Capri admite el XML firmado; una firma que sólo tenga DER produce un error explícito. La comprobación portable del ZIP no sustituye la verificación criptográfica de `codesign`.

## Compilación de comprobación sin IPA

[`check-device-archive.sh`](../apps/ios/scripts/check-device-archive.sh) está diseñado para un runner macOS limpio con Xcode 26+, XcodeGen, Node/pnpm, Rust para iOS y `cargo-tauri` 2.12.1. Genera el proyecto de Tauri con Share y Live Activity, desactiva la firma y ejecuta `cargo tauri ios build --target aarch64 --no-sign --archive-only --ci -- --locked`. Rechaza productos iOS anteriores y una IPA nueva; inspecciona el `.xcarchive` recién compilado para comprobar la app, ambas extensiones, arm64, configuración y enlaces de frameworks. El runner no debe publicar ese archivo.

Esta ruta aún requiere ejecución en un runner macOS para quedar validada. Comprueba compilación y contenido del archive: no firma, no valida entitlements embebidos, SideStore, instalación, cámara, micrófono ni comportamiento en el iPhone. El empaquetador de IPA sigue siendo una ruta separada.

## Comprobar una descarga desde Linux

Desde la raíz del repositorio, con la ruta al IPA extraído del artefacto de Actions:

```sh
python3 apps/ios/scripts/verify-ipa.py /ruta/Capri-unsigned.ipa --sealed
sha256sum /ruta/Capri-unsigned.ipa
```

Para una build con otro grupo, pasar además `--group group.identificador.configurado`. El helper no lee credenciales, no modifica la IPA y no necesita Apple SDK. El gate `--sealed` falla correctamente con la IPA anterior por ausencia de `LC_CODE_SIGNATURE`.

Las **19 pruebas de configuración y empaquetado** pasan en Linux. Usan comandos de build/firma simulados y blobs Mach-O deliberados: verifican orden, fuentes, límites, fallos, ausencia de permisos y prevención de artefactos residuales. No ejecutan la implementación criptográfica de Apple ni prueban instalación. El CI macOS y el dispositivo siguen siendo gates separados.

## Después de SideStore

SideStore vuelve a emitir la firma personal y puede ajustar el App Group con el sufijo del equipo. La revisión está fijada al [código de SideStore cd26085](https://github.com/SideStore/SideStore/blob/cd260851ae99bf1fc946b123db24e89c8cd21dc6/SideStore/Core/Operations/PipelineOperations/FetchProvisioningProfilesOperation.swift#L415); no implica que todas las versiones instaladas se comporten igual. [`AppGroupResolver.swift`](../apps/ios/plugin-device-bridge/ios/Sources/AppGroupResolver.swift) considera únicamente el grupo original o ese mismo grupo seguido de un identificador de equipo de diez caracteres, presentes en la firma de su propio ejecutable. El acceso final depende de `FileManager.containerURL`; leer una cadena no concede permisos. Una firma incompatible o más de un grupo autorizado produce un error visible.

La aceptación requiere instalar app y extensión con SideStore, compartir audio desde Notas de Voz, abrir Capri y recuperar los mismos bytes, repetir sin internet y confirmar después una renovación de firma. Mientras eso no se compruebe, importar desde Archivos conserva la alternativa explícita. No presentar Compartir como validado sólo porque la extensión aparezca dentro del ZIP.
