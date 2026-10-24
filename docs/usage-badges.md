# Porcentajes de consumo junto al chat

El chat muestra una lectura compacta de **porcentaje usado**, inmediatamente a la izquierda del botón **Ver consumo**. Los detalles completos siguen disponibles aunque desactives los porcentajes.

## Configurar

1. En el teléfono, abre **Ajustes → Porcentajes de consumo**.
2. Activa o desactiva todo el resumen, cada proveedor o sus ventanas de 5 horas y semanal.
3. Elige qué ventana tiene prioridad para cada proveedor. En el escritorio, las mismas opciones están en los ajustes del asistente y en la vista de consumo cuando esa conexión ofrece consumo.

Los cambios se aplican inmediatamente y se guardan en este navegador o aplicación, no en la cuenta del proveedor. No se guardan credenciales ni lecturas de consumo. Si el almacenamiento local está bloqueado, los cambios sólo duran en la ventana actual.

## Cómo se interpreta

| Situación | Resumen |
|---|---|
| 5 horas y semanal disponibles | Por defecto, sólo 5 horas |
| Sólo semanal disponible | Semanal |
| Prioridad personalizada | Primera ventana habilitada disponible en el orden elegido |
| Codex y Claude conectados | Un icono de proveedor, porcentaje e icono de ventana por proveedor |
| Valor no informado o ventana desconocida | `—`, nunca un `0%` inventado |
| Proveedor sin sesión, sin lecturas anteriores | No aparece |
| Lectura anterior o reinicio ya transcurrido | Porcentaje con `*`, subrayado punteado y etiqueta «lectura anterior» |
| Error de consulta sin lectura anterior | «Consumo no disponible» |

Los nombres accesibles y las ayudas del resumen identifican proveedor, ventana y porcentaje usado. `0%` sólo aparece cuando el proveedor realmente informa cero. El resumen reutiliza los datos y los iconos de la vista detallada; no representa el porcentaje restante ni calcula otro límite.

## Notas de implementación y revisión

- `UsageBadges.tsx` selecciona por duración (300 o 10080 minutos) o los IDs conocidos de Claude (`five_hour`, `seven_day`); prefiere ventanas generales a específicas cuando ambas existen.
- Una preferencia inválida o de versión desconocida vuelve al valor predeterminado explícito: visible, ambos proveedores, ambas ventanas habilitadas, 5 horas antes que semanal.
- La consulta se realiza mientras el documento está visible, respetando `refreshAt` y al menos un minuto entre lecturas. Desactivar todos los resúmenes evita sus consultas. La vista detallada mantiene su comportamiento independiente.
- La condición de lectura anterior sigue las convenciones de detalles: error de actualización, marca `stale`, proveedor no disponible con datos anteriores o `resetAt` transcurrido. No se inventa un umbral de antigüedad adicional.
- El espacio horizontal reservado mantiene estable el acceso a detalles durante carga/actualización. Los badges son informativos, no objetivos táctiles nuevos.

## Verificación

```sh
pnpm exec vitest run --maxWorkers=2 packages/ui/test/usage.test.tsx packages/ui/test/usage-badges.test.tsx
pnpm exec playwright test -c playwright.mobile.config.ts e2e/mobile-usage-badges.mobile.ts
```

Las pruebas de navegador usan respuestas sintéticas autenticadas: prueban selección, orden visual/DOM, geometría y persistencia en el shell web móvil. No constituyen prueba de cuotas reales, de una cuenta activa ni de un dispositivo Android físico. El caso de 1280 px sigue siendo el shell móvil ancho; la integración de escritorio se prueba también en React sin puente nativo.
