# Compartir una reunión con Capri

Para trabajar una reunión grabada en el iPhone con el modelo de la laptop.

## Desde Notas de Voz (Recorder)

1. Grabá la reunión en Notas de Voz.
2. Abrí la grabación → **Compartir** → **Capri**. Si el sistema ofrece la opción, elegí **Audio y transcripción** para que lleguen las dos cosas juntas.
3. Escribí un título o una nota si querés y tocá **Guardar**.
4. Abrí Capri. El material entra como un **trabajo de tipo Reunión** guardado en este iPhone, con el audio y la transcripción como archivos del mismo trabajo. Capri te avisa en la conversación; el aviso no significa que ya se envió nada a la laptop.
5. En **Bandeja**, ese trabajo tiene la acción **Generar minuta con la laptop**.

Qué se puede compartir: audio, imagen, PDF y texto. Un MP4 con pista de vídeo se rechaza después de inspeccionar las pistas, y el original no se borra. Hasta 10 archivos por compartición.

## Generar la minuta

La acción hace dos pasos, cada uno con su revisión humana en la conversación:

1. **Transferir** la revisión exacta del trabajo (archivos y versiones) a la laptop. Verás el contenido exacto antes de aprobar.
2. **Procesar** con el transcriptor y el modelo configurados en la laptop.

El resultado queda como **borrador para revisar**. Aprobar la minuta es una decisión aparte, y nada de esto envía correos, mensajes ni toca servicios externos.

Estados que vas a ver, y qué significan de verdad:

- Botón apagado con "Conecta la laptop…": la laptop no está vinculada o su Gentle Dot no anuncia minutas de reuniones. Al conectarla, la bandeja se actualiza sola.
- Botón apagado con "una transferencia… sigue en curso": hay bytes viajando o un acuse sin confirmar. Recargar la página no lo vuelve a mandar: el bloqueo está en el estado guardado del trabajo, no en la pantalla.
- "Minuta guardada sin aprobar": ya existe un borrador. Revisalo antes de pedir otro.

## Límites honestos

- La app se distribuye firmada con tu cuenta personal por SideStore. No hay push de Apple (APNs): los avisos son locales y sólo llegan si iOS los permite y la app puede completar la respuesta al salir.
- La vista de pantalla bloqueada (Live Activity) viene activada por defecto y podés apagarla en **Ajustes**. Muestra estado, nunca el contenido de la conversación.
- La transcripción de Apple y la de la laptop son fuentes distintas: Capri las contrasta y marca qué es confirmado, cuál es propuesta y cuál inferencia. No inventa nombres, fechas ni responsables.
- Nada de esto fue validado con una reunión real en un iPhone con la firma de SideStore: las pruebas que sostienen este documento corrieron en Chromium y contra un host simulado.
