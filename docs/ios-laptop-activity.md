# Observación de la laptop en pantalla bloqueada

Con la app abierta y el enlace autenticado, el usuario puede elegir mostrar una observación reciente del estado general de la laptop. El estado de trabajo no se inicia automáticamente por una conexión, un evento ni una restauración. La actividad contiene una fase general, un identificador opaco y la hora de observación; no incluye texto de conversación, nombre de sesión, dirección ni credenciales. La pantalla indica que se trata del último estado observado y ActivityKit lo considera antiguo tras 90 segundos.

Al desconectar o suspender el enlace, Capri deja de actualizar esa actividad; no supone que el trabajo terminó. La reconexión no vincula automáticamente la actividad anterior a otra laptop ni reactiva su seguimiento. El usuario puede ocultarla y elegir una observación nueva. Ocultarla no cancela trabajo. Esto no mantiene la app ejecutándose en segundo plano y la observación puede quedar antigua.

Las pruebas de navegador usan un bridge simulado. El fixture Swift y la comprobación de tipos para ActivityKit/widget en macOS son una verificación nativa aislada, no una compilación firmada ni una prueba en iPhone. Su uso efectivo, accesibilidad y presentación en pantalla bloqueada requieren validación en dispositivo.
