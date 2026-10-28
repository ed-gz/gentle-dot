# Render de Capri sin lectura de silueta en iPhone

El iPhone usa los límites táctiles de su escena y no consume la máscara nativa
del escritorio. Su llamada a `createEngine` establece `maskReadback: false`:
el motor dibuja el mismo rig, pero no reserva el buffer de lectura, no llama a
`gl.readPixels` ni calcula la máscara. `draw()` e `inputRectangles()` devuelven
listas vacías explícitas en este modo.

La opción omitida conserva el comportamiento de PC: una lectura por dibujo,
una máscara de 816 celdas y rectángulos de entrada derivados de esos mismos
píxeles. No se cambiaron shaders, poses, cadencia, efectos, restauración del
contexto ni `preserveDrawingBuffer`.

## Evidencia del 28 de octubre de 2026

El experimento aislado usó el PNG personal original, el shader compartido real,
144 × 204 píxeles y una cadencia objetivo de 12 dibujos por segundo. Se alternaron
seis bloques de cuatro segundos, después del calentamiento. El navegador fue
Headless Chromium 153.0.8010.12 sobre Linux, con ANGLE/Vulkan **SwiftShader**.

| Modo del experimento | Duración media de la llamada a `draw()` por bloque |
| --- | --- |
| Lectura y máscara actuales | 51.7–57.0 ms |
| Sin lectura, conservando el cálculo de máscara | 0.27–0.31 ms |
| Sin lectura ni máscara | 0.10–0.12 ms |

La lectura síncrona ocupó 51.4–56.7 ms por dibujo; calcular la máscara ocupó
aproximadamente 0.20 ms. En el primer dibujo frío, la lectura esperó 5.10 s al
trabajo gráfico inicial. Esto explica por qué los tests que arrancan el motor
real en un renderizador de software necesitan esperar su estado preparado.

**Estos números miden bloqueo de la llamada JavaScript, no el coste total de
renderizado ni el rendimiento del iPhone.** Al drenar explícitamente el trabajo
gráfico después de un dibujo sin lectura, todavía se midieron 62–68 ms. Los tres
modos mantuvieron aproximadamente 12 fps y hubo variación en tareas largas y
latencia del compositor. No se deduce una reducción concreta de batería,
temperatura o consumo de GPU; eso requiere mediciones en el dispositivo.

## Comprobación del cambio real

Después de implementar la opción, otro script importó directamente el motor
modificado, sin reescribirlo. Comparó los fotogramas 0, 7 y 120 con la opción
omitida y deshabilitada: los hashes SHA-256 de todos los bytes RGBA coincidieron
por fotograma, y los tres fotogramas eran distintos. El modo de PC efectuó tres
lecturas, conservó las máscaras de 816 celdas y produjo rectángulos; el de iPhone
efectuó cero lecturas y devolvió listas vacías. Ambos dibujaron tres veces, sin
errores WebGL ni errores de página.

Los tests focales del motor, rig/director y componente de escritorio pasaron
**55/55**. Comprueban uniformes, dibujo, máscara por defecto, ausencia de
lecturas al deshabilitarla y liberación de recursos. TypeScript de iOS y
`git diff --check` pasaron.

La evidencia local está en `.cache/capri-phase2-qa/`: scripts
`benchmark-capri-readback.mjs` y `verify-capri-readback-parity.mjs`, resultados
`capri-readback-benchmark.json`, `capri-readback-parity.json` y
`capri-mask-readback-tests.log`. El PNG permanece fuera del repositorio público.
