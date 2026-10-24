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

## Gmail y avisos

Primero conecta una cuenta Gmail compatible desde **Conexiones**, con OAuth propio y consentimiento de lectura. `dot_watch list` permite descubrir fuentes; Capri no inventa una conexión ni afirma vigilar antes de confirmar el registro. La primera consulta establece una base sin avisos históricos. Después deduplica mensajes, guarda el cursor y agrupa eventos para resumir según el encargo.

El resumen queda en la conversación. Cuando un informe de correo termina correctamente, el daemon emite `toast` con `notificationEvent: dotReply` e identidad estable `watch:<deliveryId>`. Llega al escritorio y al monitor Android por el WebSocket existente; no contiene remitente, asunto ni cuerpo en la pantalla bloqueada. El monitor también recibe la respuesta normal del chat, según sus preferencias. Requiere permisos de avisos y conexión; no es push independiente del equipo.

Enviar o responder correo, igual que [publicar un issue](github-issues.md), **siempre exige confirmación humana real**, incluso si forma parte de un encargo. El contenido del correo no autoriza nada.

## Añadir detalles mientras la sesión pregunta

La pregunta pendiente aparece como tarjeta con sus opciones encima del compositor del teléfono, sin abrir detalles de la sesión. Puedes responder allí y también escribir información adicional: el mensaje humano queda **«En cola: se enviará cuando respondas la pregunta»**, conserva su orden y se entrega como `followUp` después de resolverse la pregunta. No se usa ese texto como respuesta al permiso. Los prompts autónomos siguen rechazándose mientras hay una pregunta pendiente. La cola del adaptador es acotada y vive en memoria de esa sesión; no promete supervivencia al cierre o caída de su proceso.

## Ver y detener

Usa «mostrame qué estás vigilando», «pausá la vigilancia de X», «seguí vigilando X» o «dejá de vigilar X». Capri lista primero y usa el identificador exacto. `dot_watch` tiene list/pause/resume/delete; `dot_workflows` tiene list/pause/resume/stop. Las vigilancias de sólo avisos también están en Ajustes → Dot 24/7. Un tema nuevo en el chat no cambia estos encargos. No uses un bucle de consultas al modelo para esperar eventos.
