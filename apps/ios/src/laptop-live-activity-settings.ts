import { isTauri } from '@tauri-apps/api/core';
import type { ServerMessage } from '../../../packages/protocol/src/index.ts';
import { createLaptopLiveActivity } from './laptop-live-activity.ts';
import type { createLiveActivityCoordinator } from './live-activity-coordinator.ts';

type StateEvent = Extract<ServerMessage, {type:'ready'|'agent_state'}>;
/** Explicitly display only an authenticated, recent aggregate event. Never
 * start a new activity on reconnect, foreground restoration or a host event. */
export function mountLaptopLiveActivity(root:HTMLElement, coordinator:ReturnType<typeof createLiveActivityCoordinator>, options:{
  connected:()=>boolean; visible:()=>boolean; native?:boolean; now?:()=>number;
}) {
  const button=root.querySelector<HTMLButtonElement>('button')!, status=root.querySelector<HTMLElement>('[role="status"]')!;
  const native=options.native ?? isTauri(), now=options.now ?? Date.now;
  const observer=createLaptopLiveActivity({coordinator});
  let latest:{event:StateEvent;at:number}|undefined, active=false, tracking=false, busy=false, warning='', generation=0;
  let staleTimer:ReturnType<typeof setTimeout>|undefined;
  const phase=(event:StateEvent)=>event.type==='ready'?event.agentState:event.state;
  function render() {
    const current=coordinator.snapshot(), recent=!!latest && now()-latest.at>=0 && now()-latest.at<=90_000;
    const displaying=active && current.activity?.origin==='laptop';
    button.textContent=displaying?'Ocultar estado de la laptop':'Mostrar estado de la laptop';
    button.disabled=!native || busy || (!displaying && (!options.visible() || !options.connected() || !current.enabled || current.status!=='ready' || !recent || !latest || !['thinking','working','needs_you'].includes(phase(latest.event))));
    if (warning) status.textContent=warning;
    else if (!native) status.textContent='Disponible en la app instalada en el iPhone.';
    else if (displaying && (!options.visible() || !options.connected())) status.textContent='Sin señal. La pantalla muestra la última observación, no el estado actual.';
    else if (displaying && !tracking) status.textContent='El seguimiento se interrumpió. Oculta la observación anterior antes de elegir otra.';
    else if (displaying && current.activity && (current.activity.stale || now()-current.activity.observedAt>90_000)) status.textContent='Sin señal reciente. Abre Capri para consultar la laptop.';
    else if (displaying && current.activity) status.textContent=`Última observación: ${new Date(current.activity.observedAt).toLocaleTimeString('es-MX')}. No incluye contenido de la conversación.`;
    else if (current.status==='uncertain') status.textContent='No se confirmó la actividad. Comprueba la pantalla bloqueada antes de continuar.';
    else if (!current.enabled) status.textContent='Activa primero el progreso en pantalla bloqueada.';
    else if (!options.connected() || !options.visible()) status.textContent='Conecta la laptop y abre Capri para consultar su estado.';
    else if (!latest || !recent) status.textContent='Esperando una observación reciente de la laptop.';
    else if (!['thinking','working','needs_you'].includes(phase(latest.event))) status.textContent='La laptop no informa trabajo activo. No se inicia una actividad.';
    else if (current.activity) status.textContent='Ya hay otra actividad. Puedes revisarla antes de mostrar la laptop.';
    else status.textContent=`Última observación: ${new Date(latest.at).toLocaleTimeString('es-MX')}. No incluye contenido de la conversación.`;
  }
  button.addEventListener('click',()=>{
    if (busy) return;
    const current=coordinator.snapshot();
    if (active && current.activity?.origin==='laptop') {
      busy=true;warning='';render();
      void observer.setEnabled(false).then(()=>{active=false;tracking=false;}).catch(()=>{warning='No se confirmó el cierre. Comprueba el estado antes de volver a intentarlo.';}).finally(()=>{busy=false;render();});
      return;
    }
    const observation=latest;
    if (!native || !options.connected() || !options.visible() || !observation || now()-observation.at<0 || now()-observation.at>90_000 || !current.enabled || current.status!=='ready') return;
    busy=true;warning='';render();const captured=generation;
    void observer.setEnabled(true).then(()=>{
      if (captured!==generation || latest!==observation || !options.connected() || !options.visible()) throw new Error('La observación cambió.');
      return observer.start(observation.event,observation.at);
    }).then(()=>{
      active=coordinator.snapshot().activity?.origin==='laptop';
      tracking=active && captured===generation && options.connected() && options.visible();
      if (!active) warning='No se inició la actividad. Comprueba la conexión y vuelve a revisar el estado.';
    }).catch(()=>{warning='No se confirmó la actividad. Comprueba su estado antes de volver a intentarlo.';}).finally(()=>{busy=false;render();});
  });
  return {
    render,
    disconnected() { generation++; latest=undefined; tracking=false; clearTimeout(staleTimer); observer.disconnected(); render(); },
    observe(event:StateEvent) {
      if (!options.connected() || !options.visible()) return;
      const at=now(); latest={event,at}; warning='';
      clearTimeout(staleTimer); staleTimer=setTimeout(render,90_001);
      void observer.message(event,at).catch(()=>{warning='No se confirmó la actividad. Comprueba su estado.';render();});
      render();
    },
  };
}
