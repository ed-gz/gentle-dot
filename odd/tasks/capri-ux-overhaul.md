# Capri and mobile UX overhaul
Branch fix/android-capri-motion-mobile (single source of truth; feat/android-orchestration is a subset and is not merged).
Fix Capri on desktop and Android, repair Android notifications, simplify mobile IA/settings, and remove over-engineering.

## Specs
S1. Desktop ghost box: "en la PC se ve ese recuadro fantasma cuando capri esta activa como sprite y no debe exsitir, cuando se oculta capri ahi si aparece en u siti sin molestar"
S2. Desktop features: "Ya dentro de este todas las funcionalidade smoviles pues esta snecilito y creo que podria aprovecharse y mejorarse"
S3. Android persistent Capri: "Capri en la pantalla como asistente activa permanente no funciona correctmaente, sus diferentes sprites no reaccionan, cuando se bloquea el celular desaparece totalmente al desbloquearlo"
S4. Android notifications: "sus notificaciones dentro del celular no sirven"
S5. Mobile UI and settings: "toda la visual del movil es una basura tanto en manejo de sesiones como otras funciones, su configuracion y organizacion es horrible por lo tecnica y desglozada mal que eesta"
S6. Over-engineering: "hay una soibreingeneria tremenda que hay que matar"
S7. Single branch: "la idea es volver todo junto en uno por que realmente seria la msima logica" / "quiero la version mas trabajada como prioridad"

## Tasks
T0 | S7 | parent | DONE — capri branch is a superset; imported orchestration odd/tasks history docs only.
T1 | S1,S6 | parent | IN PROGRESS — launcher window stays mapped with profile blur/shadow while hidden (opacity 0) = ghost square; apply the same silhouette rule as dot/bubble, delete launcher_rule/verify_launcher special case.
T2 | S3 | parent | Android overlay: push agent state (working/attention/done/idle) into CompanionSpriteView with exhaustive mapping; START_STICKY + restart when enabled but not running; keep keyguard hide.
T3 | S4 | parent | Android notifications: monitor not running on device; start on boot/app resume when paired, surface a single clear status (on / needs permission / disconnected) with a fix action.
T4 | S5-S6 | parent/worker | Mobile IA: regroup Ajustes (Avisos, Capri, Personalización, Avanzado), hide technical session details under Avanzado, simplify session creation/close; split ChatSurface where it lowers complexity.
T5 | S2 | parent | Desktop feature improvements (after T1-T4).
T6 | S1-S6 | parent | build, install and verify on the connected Pixel 9a

## Log
L1 user request verbatim: "Necesito que me ayudes a hacer mas chido el branch que andamos trabajando con lo de gentle dot en respecto a sus funcionalidades, mejorar UX/UI a por mil por que actualmente es una mierda, hacerlo eficiente util y sobre todo mejorar nuestro tema de Capri! Capri me encanta, quiero integrarlo a mil pero hay bugs importantes de vistas, ademas de loq ue encuentres, hay una soibreingeneria tremenda que hay que matar [screenshot] De lo mas sencillo, en la PC se ve ese recuadro fantasma cuando capri esta activa como sprite y no debe exsitir, cuando se oculta capri ahi si aparece en u siti sin molestar Ya dentro de este todas las funcionalidade smoviles pues esta snecilito y creo que podria aprovecharse y mejorarse AHora movil! la belleza real Tengo conectado el cel por si quieres hacer pruebas instalar updates etc Ene ste Comenzando con lo que es Capri en la pantalla como asistente activa permanente no funciona correctmaente, sus diferentes sprites no reaccionan, cuando se bloquea el celular desaparece totalmente al desbloquearlo sus notificaciones dentro del celular no sirven, toda la visual del movil es una basura tanto en manejo de sesiones como otras funciones, su configuracion y organizacion es horrible por lo tecnica y desglozada mal que eesta Analiza y emjoralo"
L2 user: "la idea es volver todo junto en uno por que realmente seria la msima logica"; then "mer evolvi, es que honestamente hay mucho desorden, quiero la version mas trabajada como prioridad". Decision: work in /home/egarza/gentle-dot-capri. Evidence: it already contains mobile-approvals.ts and workflow-authorization.ts; orchestration-only files are obsolete Capri v1 assets plus 5 odd docs.
L4 exploration: desktop ghost = companion-launcher 56x56 window mapped at all times (hyprctl confirms mapped while Dot visible), launcher_rule preserves profile blur/shadow/rounding (desktop_companion.rs launcher_rule), paint_window only zeroes opacity/input. Android: sprite only animates on taps and some notices, agent state never reaches it, CompanionPolicy.action defaults to greeting; overlay START_NOT_STICKY; monitor has no boot/restart path. Mobile IA: ChatSurface >1300 lines holds nav+chat+14 settings entries; session creation needs a local folder path; session close hidden in details menu; no rename.
L3 device evidence (Pixel 9a, 0.21.4/code 38): CompanionOverlayService runs as foreground specialUse with overlay window present; AgentMonitorService is NOT running; POST_NOTIFICATIONS and SYSTEM_ALERT_WINDOW granted.
