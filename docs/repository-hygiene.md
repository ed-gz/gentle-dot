# Publicar fuentes sin datos privados

El repositorio contiene lo necesario para entender y construir Gentle Dot con el tema opcional Capri. Las compilaciones, cuentas y datos de una instalación pertenecen al equipo de quien la usa. No hay que copiar la carpeta de una instalación activa para contribuir.

## Qué incluir

| Incluir | Mantener fuera de Git y de los adjuntos públicos |
| --- | --- |
| Código, pruebas, scripts de construcción y lockfiles | APK, AAB, DMG, DEB, ejecutables, bibliotecas compiladas y archivos comprimidos de distribución |
| Sprites PNG, iconos, manifiestos y procedencia del tema | Claves de firma, certificados privados, tokens, archivos de cuentas y `.env` reales |
| Instrucciones y ejemplos ficticios | `~/.gentle-dot`, `~/.engram`, historial de conversaciones, volcados, logs y bases de datos locales |
| `.env.example` con valores ficticios, si se necesita | QR de vinculación, URL con clave de acceso, nombres privados de la red Tailscale y datos de clientes |
| Gradle wrapper con checksum verificado | Cachés, `node_modules`, `dist`, `build`, `target` y WebViews generadas |

Los sprites son recursos fuente del tema que la aplicación necesita para renderizar; no se eliminan como si fueran APKs. `gradle-wrapper.jar` es una excepción concreta de herramienta de construcción, validada por ruta y SHA-256. Cambiarlo exige revisar y actualizar ese checksum. Las reglas no aceptan cualquier JAR.

## Antes de publicar

Revisa `git status --short` y añade únicamente los archivos de la tarea. Las comprobaciones necesitan Node 24 y Gitleaks 8.30.1, instalado como se indica debajo. Desde la raíz del repositorio:

```sh
pnpm security:check
pnpm security:test
pnpm security:history
pnpm security:secrets
git diff --cached --check
```

`security:check` inspecciona los blobs del índice, no una copia limpia que pudiera ocultar lo ya preparado. Rechaza rutas de credenciales y compilaciones, submódulos y firmas de binarios incluso si se cambió su extensión. `security:history` amplía la revisión a los commits alcanzables por las referencias locales. Antes de una auditoría de lo remoto, actualiza sus referencias o usa un clon espejo nuevo.

Para buscar valores de secretos, instala la versión verificada de [Gitleaks](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) y ejecuta:

```sh
pnpm security:secrets
```

El comando usa las reglas predeterminadas desde una configuración temporal y no admite supresiones inline `gitleaks:allow`. Sólo aplica las excepciones históricas exactas de `.gitleaksignore`. Revisa también los cambios introducidos al resolver fusiones. Necesita `gitleaks` en `PATH`; también admite una instalación local verificada en `.cache/tools/gitleaks`.

El workflow de GitHub realiza estas comprobaciones sin instalar las dependencias de la aplicación. Descarga una versión fija del escáner y verifica el SHA-256 del archivo antes de ejecutarlo. Las acciones también están fijadas por commit y el workflow sólo tiene permiso de lectura sobre el repositorio. No genera ni publica instaladores o informes como artifacts.

Para ejecutarlas también **antes de enviar objetos a GitHub**, instala Gitleaks y activa el hook de este clon:

```sh
git config --local core.hooksPath .githooks
```

Si ya usas otros hooks, integra el contenido de `.githooks/pre-push` en ellos en vez de reemplazarlos. El hook detiene el push si falta el escáner o falla una comprobación. Git no instala hooks automáticamente al clonar; cada colaborador debe activarlo. El hook local puede omitirse deliberadamente y el workflow detecta problemas después de subirlos: ninguno convierte el repositorio en una garantía absoluta contra publicaciones sensibles.

`.gitignore` evita añadidos accidentales; no quita archivos que ya estuvieran versionados y no impide `git add -f`. Por eso las comprobaciones inspeccionan Git y no dependen sólo de las exclusiones.

## Coincidencias de prueba y límites

`.gitleaksignore` admite dos coincidencias históricas revisadas del mismo valor sintético de `computer_register`: el commit que introdujo la prueba y el que fusionó su rama. La prueba actual construye un valor con `fixture-token`. Cada excepción incluye commit, archivo, regla y línea; no silencia futuros secretos en ese archivo. Cualquier excepción nueva debe justificarse y revisarse con el mismo alcance limitado.

Un resultado limpio significa que las comprobaciones configuradas no encontraron problemas. No garantiza detectar una clave con formato desconocido, datos sensibles dentro de una imagen, una URL privada nueva o contenido cifrado. Antes de subir capturas, sprites de referencia o documentación, revísalos también visualmente y elimina datos ajenos a la tarea.

## Compilar y compartir

Sigue el [README](../README.md) y las guías de la plataforma. Las salidas quedan en directorios locales ignorados. Una APK firmada localmente puede instalarse en tus propios dispositivos; esa acción no la publica en GitHub. La política de este fork es mantener también releases y artifacts públicos sin instaladores compilados. Un cambio de esa política requiere una decisión explícita, no añadir archivos de `build` al commit.

Para comunicar una exposición real o una vulnerabilidad, sigue [SECURITY.md](../SECURITY.md). Revocar un secreto y eliminarlo del historial son acciones distintas.

## Auditoría inicial de esta política

El 23 de octubre de 2026 se revisaron las ocho ramas públicas existentes antes de esta actualización: 252 commits, 902 rutas históricas y 1.940 versiones de blobs. No se detectaron credenciales reales ni compilados del producto. GitHub no tenía releases, adjuntos de releases, artifacts de Actions ni alertas de secretos. Se verificaron las dos apariciones históricas del mismo token ficticio descritas arriba y se normalizó una ruta local heredada de upstream en la documentación actual.

Los 45 PNG del árbol actual no contienen chunks de texto ni EXIF. Esta comprobación no es OCR ni revisión de información visible en cada imagen. El alcance se limita a referencias accesibles: no certifica objetos remotos eliminados, clones de terceros ni cambios posteriores. Las comprobaciones automáticas deben repetirse al publicar.
