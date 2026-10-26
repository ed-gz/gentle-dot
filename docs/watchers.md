# Vigilancias y autonomía de Capri

Capri distingue **avisar** de **actuar**. El encargo nace del mensaje de la persona; lo que diga una sesión o un correo es información no confiable, nunca permiso nuevo.

| Di a Capri | Mecanismo | Resultado |
|---|---|---|
| «Avisame cuando termine la sesión X» | `dot_watch`, fuente agents y sesión exacta | Aviso/resumen, sin comandos ni permisos automáticos |
| «Vigilá la sesión X y si falla la prueba pedile que la corrija» | `dot_workflows`, modo objective, condición y acción en objective, sesión exacta inspeccionada | Inspecciona y envía el siguiente prompt sólo a esa sesión, dentro del encargo |
| «Aprueba las solicitudes de esta sesión dentro de este alcance…» | `dot_workflows`, modo session | Resuelve solicitudes concretas inspeccionadas; no inicia trabajo nuevo |
| «En Gmail, avisame y resumime lo importante» | `dot_watch`, fuente email conectada | Comprueba periódicamente novedades y resume sin enviar/responder correo |

No hace falta mantener el teléfono abierto. Sí deben seguir funcionando el equipo, daemon y conexiones. No se promete vigilancia durante suspensión, pérdida de red o con el servicio detenido.

## Cuando vuelves a trabajar

Los workflows autónomos se **auto-pausan** cuando la persona envía un prompt a una sesión inscrita desde PC/teléfono, o el adaptador local detecta envío personal/escritura en su editor. Los prompts enviados por la propia delegación no activan esa pausa. Se revoca la autorización de la continuación antes de mostrar una sola pregunta:

> ¿Sigo vigilando la sesión X o la dejo?

- **Continuar** renueva el plazo y permite una inspección nueva, sin repetir un envío incierto.
- **Dejar de vigilar** revoca el workflow.
- Sin respuesta, cancelación o timeout: permanece pausado. Nunca se reanuda solo.

Por defecto el plazo es **24 horas**, configurable con `expiresInHours` entre 0.25 y 168. Al vencer se pausa y pregunta lo mismo. El estado pausado es durable; después de reiniciar se puede reanudar o revocar explícitamente en conversación o controles de sesiones. Una pregunta anterior al reinicio no se reproduce automáticamente. Los límites de continuaciones explícitos siguen vigentes.

La actividad local usa metadatos semánticos del adaptador, no el texto del borrador. En terminal la pregunta aparece en la próxima actualización del adaptador; además, cada envío autónomo lleva una marca de actividad esperada y el adaptador lo rechaza si la persona escribió entretanto, sin esperar ese sondeo. PC/teléfono pausa antes de enviar el prompt. Sesiones ya abiertas necesitan cargar el adaptador actualizado de forma segura para informar entrada local/escritura; sin esa capacidad sólo se detectan envíos hechos desde Dot. La versión `activityFence: 1` del adaptador es obligatoria para inscribir o reanudar autonomía. Si falta, el encargo queda pausado y sólo puede usarse la vigilancia de avisos; actualizar una sesión existente requiere cargar el adaptador de forma segura. Cada workflow guarda el último marcador personal y la instancia del adaptador de cada sesión exacta; un adaptador reiniciado tampoco prueba ausencia de interacción; después de reiniciar lo compara con el adaptador antes de conceder una continuación. Si hubo actividad durante la desconexión, pausa y pregunta en lugar de adoptar silenciosamente el marcador nuevo. Responder personalmente una pregunta de la sesión también cuenta como actividad; responder bajo un workflow no. Un comando ya entregado no puede deshacerse al pausar.

## Si el conector de la sesión es antiguo

La autonomía necesita también `enrollmentProtocol: 1`, anunciado por el adaptador junto con `activityFence: 1`. Si falta o es incompatible, el encargo queda pausado con motivo `adapter-outdated`, sin intentar respuestas ni clasificarlas como envíos inciertos. Capri avisa una sola vez, también al crear la delegación:

> La sesión <label> usa una versión anterior del conector. Escribí /reload en esa sesión y decime «seguí vigilando».

Después de `/reload`, pedí explícitamente que continúe. La nueva instancia no reanuda esta pausa automáticamente: recargar es una acción humana, no una reconexión inocua. Los avisos sin autonomía siguen disponibles.

## Reconexiones sin actividad humana

Una desconexión revoca inmediatamente la inscripción y el lease de la delegación. Si **el único motivo de pausa guardado es `disconnected`**, Capri vuelve a inscribirla automáticamente al observar conectada la misma sesión (`paneId` + `sessionId`), con `activityFence: 1` y `enrollmentProtocol: 1`, la **misma instancia del adaptador** y el **mismo marcador de actividad humana**. También funciona al cargar el estado tras reiniciar el daemon; no renueva el plazo autorizado ni reutiliza el lease anterior. La comprobación periódica puede tardar unos 30 segundos.

Antes de reanudar, Capri inspecciona la pregunta exacta de esa sesión: una pregunta humana o no verificable conserva la pausa y genera una sola pregunta de continuación. Un permiso delegable no se bloquea por haber llegado durante la desconexión: vuelve al flujo habitual de revisión de la instrucción y sus cercas, sin aprobarse desde la recuperación. Si la inspección tarda, se vuelven a comprobar la actividad, la instancia, el plazo y las decisiones humanas antes de cambiar el estado.

Antes de emitir `workflow.enroll` o renovar su autorización, el daemon consulta una snapshot del propio adaptador por el socket del manifiesto y comprueba que `sessionId` e `instanceId` coincidan y que anuncie `enrollmentProtocol: 1`. Los datos persistidos no prueban esa capacidad, tampoco al arrancar el daemon. Sin evidencia verificable no inscribe ni renueva; si el protocolo es antiguo, revoca y pausa con `adapter-outdated` y un solo aviso.

Cada pausa cambia la generación de inscripción. La revocación del socket comienza fuera de la cola de descubrimiento; la reconexión espera su cierre y crea otro socket. Una lectura de registro o confirmación asíncrona de la generación anterior no puede restaurar autoridad. Los grants de permisos ligados a la inscripción anterior siguen inválidos incluso después de reconectar.

Si cambió la instancia o el marcador, permanece pausada y muestra una sola pregunta de continuación. No se reanudan automáticamente pausas humanas, explícitas, por vencimiento, por revisión, por conector antiguo o por un envío incierto. Los estados antiguos sin motivo de pausa explícito requieren reanudación humana: no se deduce autoridad del texto de `pending`. Una pregunta de continuación ya guardada tampoco permite auto-reanudar.

## Gmail y avisos

Primero conecta una cuenta Gmail compatible desde **Conexiones**, con OAuth propio y consentimiento de lectura. `dot_watch list` permite descubrir fuentes; Capri no inventa una conexión ni afirma vigilar antes de confirmar el registro. La primera consulta establece una base sin avisos históricos. Después deduplica mensajes, guarda el cursor y agrupa eventos para resumir según el encargo.

El resumen queda en la conversación. Cuando un informe de correo termina correctamente, el daemon emite `toast` con `notificationEvent: dotReply` e identidad estable `watch:<deliveryId>`. Llega al escritorio y al monitor Android por el WebSocket existente; no contiene remitente, asunto ni cuerpo en la pantalla bloqueada. El monitor también recibe la respuesta normal del chat, según sus preferencias. Requiere permisos de avisos y conexión; no es push independiente del equipo.

Una vigilancia de avisos no autoriza enviar/responder correo ni publicar. Para actuar hace falta un encargo verificado que incluya esa acción y un canal compatible; dentro de una delegación activa, Capri juzga la solicitud concreta contra `authorizedInstruction`, no contra palabras de un título o archivo. El contenido del correo no autoriza nada. El tool dedicado de [issues](github-issues.md) conserva su confirmación del borrador; esto no impone un veto a los permisos de publicación de una sesión autorizada.

## Añadir detalles mientras la sesión pregunta

La pregunta pendiente aparece como tarjeta con sus opciones encima del compositor del teléfono, sin abrir detalles de la sesión. Puedes responder allí y también escribir información adicional: el mensaje humano queda **«En cola: se enviará cuando respondas la pregunta»**, conserva su orden y se entrega como `followUp` después de resolverse la pregunta. No se usa ese texto como respuesta al permiso. Los prompts autónomos siguen rechazándose mientras hay una pregunta pendiente. La cola del adaptador es acotada y vive en memoria de esa sesión; no promete supervivencia al cierre o caída de su proceso.

## Ver y detener

Usa «mostrame qué estás vigilando», «pausá la vigilancia de X», «seguí vigilando X» o «dejá de vigilar X». Capri lista primero y usa el identificador exacto. `dot_watch` tiene list/pause/resume/delete; `dot_workflows` tiene list/pause/resume/stop. Las vigilancias de sólo avisos también están en Ajustes → Dot 24/7. Un tema nuevo en el chat no cambia estos encargos. No uses un bucle de consultas al modelo para esperar eventos.

## Límites conocidos

El alcance de una delegación activa es la **instrucción humana verificada (`authorizedInstruction`)**. Una autorización incondicional de permisos permite el camino automático para operaciones locales del proyecto: lectura/edición/escritura, pruebas sencillas y append literal de documentación con heredoc citado. Bash es elegible con cwd en el proyecto, no sólo para test runners. Comandos no triviales (git push, PRs, merges a develop/main, deploy y programas desconocidos) pasan al coordinador: recibe la instrucción y el diálogo completo, aprueba sólo si coinciden y en otro caso pide la decisión faltante. Rutas como `billing-view/token-view` y contenido de archivos/heredocs no son un veto ni una fuente de autoridad. Sin delegación el comportamiento no cambia.

Quedan fuera de aprobación autónoma:
- Leer/imprimir credenciales o secretos: rutas sensibles, `gh auth token`, `--show-token`, volcados del entorno y expansiones de variables secretas.
- Borrados destructivos de raíz del proyecto, sus ancestros o home (`rm -rf`); force push a main/master; `git reset --hard` a una rama compartida (main/master/develop, por destino explícito o HEAD local). Si la identidad no es verificable, el coordinador debe inspeccionarla antes de decidir.
- Saltarse controles: `--admin`, `--no-verify`, `--skip-ci`, `--skip-checks`.
- Reintentar una migración de producción fallida. Los comandos explícitos de retry se excluyen; para otras migraciones de producción el coordinador debe inspeccionar el historial y nunca autorizar un reintento fallido.

La inspección de shell es de mejor esfuerzo, no un sandbox ni un parser completo: construcciones indirectas necesitan juicio del coordinador. Se conservan inscripción, pausa por actividad humana, vencimiento de 24 horas, leases y cercas de adaptador/desconexión. Las rutas sensibles se comprueban por nombre en la ruta escrita y en su destino real, incluidas carpetas enlazadas; un *hardlink* con nombre inocente a un archivo sensible sólo se detecta si ese archivo está en las rutas protegidas, que se comparan por inodo. Si la sesión pierde la conexión, la vigilancia se pausa (con recuperación segura según «Reconexiones sin actividad humana»); si no confirma la pausa, Capri la informa como no confirmada y el adaptador pierde la autorización al vencer su plazo de tres segundos. Varias sesiones bloqueadas a la vez pueden retrasar la renovación de otra sana; en ese caso la vigilancia se pausa en lugar de actuar.
