# Usar una cuenta de GitHub existente

Capri puede utilizar una cuenta ya conectada con GitHub CLI (`gh`) en el escritorio. Antes de afirmar que falta una cuenta, comprueba el estado real de la herramienta. **Sesiones** muestra agentes y sus tareas; **Cuentas** conecta proveedores de modelos. Conectar GitHub Copilot allí no conecta la API de issues.

Para una tarea de GitHub, Capri debe comprobar que `gh` está disponible, verificar la cuenta para el host correspondiente y usar el repositorio indicado. Una solicitud de crear un issue autoriza esa creación concreta; una consulta de estado no autoriza publicar. Solo debe confirmar la creación cuando GitHub devuelva el resultado y su enlace.

El motor conserva su carpeta personal aislada. Si ya tiene `home/.config/gh/hosts.yml`, mantiene esa configuración. En otro caso, en el escritorio puede reutilizar la carpeta original de GitHub CLI mediante `GH_CONFIG_DIR`: primero `$XDG_CONFIG_HOME/gh`; solo en Windows, después `$AppData/GitHub CLI` (también acepta `APPDATA`); finalmente, `$HOME/.config/gh`. Linux ignora ambas variables de AppData. Se elige la ruta que corresponde a las variables disponibles y se comprueba que exista `hosts.yml`; no se buscan cuentas alternativas cuando esa ruta está vacía. Un `GH_CONFIG_DIR` explícito siempre tiene prioridad.

Esta selección transmite una ruta, sin leer ni copiar el contenido de `hosts.yml`, extraer tokens o cambiar `HOME` al directorio personal real. GitHub CLI sigue resolviendo sus propias credenciales, incluido el llavero del sistema. No se comparte automáticamente la configuración del anfitrión en modo VPS ni cuando el motor usa otro contexto de acceso.

El diagnóstico debe describir el resultado observado:

| Resultado | Mensaje y siguiente paso |
|---|---|
| No existe `gh` | La herramienta no está instalada o no está disponible en la ruta del proceso. |
| No hay cuenta válida para ese host | Hace falta autenticar GitHub CLI para ese host; la persona completa el inicio de sesión en el flujo oficial. |
| Falló la red | No se pudo verificar GitHub; revisar la conexión antes de concluir que falta una cuenta. |
| La cuenta no puede acceder al repositorio o crear issues | Indicar el repositorio y la operación rechazada; comprobar la cuenta activa y sus permisos. Un error 404 también puede ocultar un repositorio privado. |
| El servidor confirmó la creación | Mostrar el enlace del issue creado. |

No solicitar contraseñas ni tokens en el chat, imprimir credenciales o indicar que un inicio de sesión de GitHub existe en **Sesiones**. La presencia de `hosts.yml` solo permite localizar una configuración; no demuestra que la cuenta o sus permisos sigan siendo válidos.
