# Responder solicitudes sin salir de la conversación

En **Ajustes → Permisos y preguntas**, el teléfono permite elegir dónde responder. La elección se recuerda localmente en este navegador/WebView; no cambia la autorización del teléfono ni los permisos de Android.

## Ruta rápida

1. **Dentro de cada conversación** (predeterminado): los permisos de Dot aparecen en su chat, incluso sin una solicitud duplicada en el historial. Las preguntas y permisos del agente aparecen dentro de su sesión seleccionada, filtrados por `paneId` y `sessionId`.
2. **Ventana emergente con respuestas**: una sola ventana reúne las solicitudes pendientes de Dot y agentes, con sus controles reales. No es un enlace a la lista de agentes. Incluye el nombre de la sesión cuando su identidad coincide.
3. **Cerrar sin responder**, Escape o Atrás cierra la ventana sin aceptar ni rechazar. **Ver solicitudes pendientes** vuelve a abrirla. Una solicitud nueva puede volver a mostrarla.

## Qué se conserva

| Tema | Comportamiento |
|---|---|
| Respuestas | Se reutilizan `AskCard`, `AgentPermissionCard` y `DotApprovalCards`, con sus rutas existentes. No se fabrica una aprobación al abrir/cerrar la ventana. |
| Seguridad | La disponibilidad del equipo, identidad exacta de sesión, autorización del teléfono, vencimiento, interfaz soportada y bloqueo durante el envío siguen vigentes. Los controles se bloquean al desconectar. |
| Varias solicitudes | La ventana tiene desplazamiento; las solicitudes desaparecen cuando el servidor confirma el nuevo estado. Las respuestas de Dot se retiran tras el acuse de la operación; errores conservan la solicitud. |
| Foco | El foco inicial va a **Cerrar sin responder**, nunca a aprobar. El diálogo nativo contiene el foco; al cerrar se restaura a un elemento conectado y no oculto, o al botón para reabrir. |
| Pantallas ocultas | No se montan tarjetas accionables duplicadas en la conversación o sesión de fondo. El modo inline sólo monta las tarjetas de la conversación visible. |
| Preferencia local | Clave `gentledot.request-presentation`, valores `inline`/`popup`. No amplía las preferencias compartidas de Android. Si el almacenamiento falla, el cambio se conserva sólo en memoria. |

La presentación de solicitudes es independiente de los banners efímeros: desactivar un aviso no acepta, rechaza ni oculta una solicitud que necesita respuesta. Los avisos nativos en primer plano conservan su tipo (`dotReply`, `dotError`, `agentCompleted`, `agentAttention`, `agentError`, `agentAvailable`, `permission`) y la identidad opcional de sesión; los banners respetan `inApp` y el interruptor de ese evento. Una respuesta de Dot que ya se está leyendo no añade un aviso redundante.

## Verificación y límites

- `packages/ui/test/request-presentation.test.tsx`: conversación de Dot sin desvío, persistencia, ventana única, respuestas literales, propietario correcto, cierre sin respuesta, desaparición, vencimiento e interfaces no soportadas/desconexión.
- `packages/ui/test/agent-permissions.test.tsx` y `dot-approvals.test.tsx`: mantienen las pruebas de opciones, descripciones, entrada/editor, formularios personalizados, autorización y vencimiento.
- `apps/mobile/test/native.test.ts`: tipos nativos conocidos, identidad, descarte de campos opacos/eventos desconocidos y propietario único de avisos del monitor activo.
- `packages/ui/test/floating-notices.test.tsx`: filtros de eventos/`inApp`, deduplicación y contexto visible.
- `e2e/mobile-request-presentation.mobile.ts`: shell móvil real con red y puente nativo simulados; respuesta inline, popup accionable, cierre/reapertura, foco, persistencia y aviso nativo genérico en retrato/paisaje con movimiento reducido.

**Estas pruebas no prueban entrega física en Android.** No se compiló ni instaló un APK ni se validaron permisos del sistema, canales, supervivencia en segundo plano o reconexión de un teléfono. El contrato del listener no es un acuse de entrega. Las credenciales y opt-ins existentes siguen siendo necesarios; no se afirma haber resuelto todas las causas de notificaciones ausentes.
