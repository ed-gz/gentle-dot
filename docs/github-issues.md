# Crear issues con Capri

Di: **«Capri, levantá un issue en OWNER/REPO con este problema…»**. Capri prepara el borrador y `github_issue create` muestra repositorio, título, cuerpo y etiquetas en la confirmación del equipo o teléfono. Sólo publica al aprobar; rechazar, cancelar o dejar vencer la pregunta no crea nada. Una delegación tampoco sustituye esta confirmación.

## Requisitos y límites

- `github_issue status` comprueba que el `gh` local existe y está autenticado en github.com. Sólo usa el código de salida de `gh auth status --active --hostname github.com`; descarta toda su salida.
- La autenticación se completa directamente con GitHub CLI por la persona. Capri no pide ni lee tokens, contraseñas o archivos de credenciales.
- Usa `OWNER/REPO`, título de hasta 256 caracteres y cuerpo de hasta 16 000. Etiquetas admitidas: `bug`, `enhancement`, `documentation`, `question` (hasta cuatro, sin repetir).
- La creación ejecuta `gh issue create --repo … --title … --body … [--label …]` con argumentos separados, **sin shell**, en el daemon local con la autenticación existente. No funciona en modo servidor ni en GitHub Enterprise.

Capri debe revisar reglas, plantilla y duplicados antes de proponer el issue. Sólo una URL `https://github.com/OWNER/REPO/issues/N` devuelta por gh confirma la creación. Un error o desconexión después del envío puede dejar una creación incierta: revisa el repositorio antes de reintentar para no duplicarla. El diagnóstico no reproduce stderr ni salida de autenticación.

## Límite de seguridad del shell

El entorno del motor elimina `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` y `GITHUB_ENTERPRISE_TOKEN`. El daemon conserva su autenticación para ejecutar la herramienta confirmada. El guard bloquea variantes reconocibles de `gh issue/pr create`, flags antes del subcomando, algunas invocaciones con variables/comillas y escrituras de `gh api` sobre issues/PRs. **Es una protección de mejor esfuerzo, no un sandbox de shell**: el shell del agente todavía puede usar el keyring/configuración de gh de la persona, y programas arbitrarios pueden construir comandos que el análisis textual no reconoce. `github_issue` es la vía soportada con confirmación; no debe sustituirse por comandos de publicación.

Las delegaciones nunca responden por la persona a un diálogo de publicación, correo o envío externo, aunque su instrucción original diga aprobar permisos. La clasificación usa metadatos del diálogo y, conservadoramente, su título y vista previa; una decisión de este tipo queda para respuesta humana directa.

Consulta [las vigilancias](watchers.md) para delegaciones y correo.
