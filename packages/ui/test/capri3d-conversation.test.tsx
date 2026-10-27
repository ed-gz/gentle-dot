import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../src/store.ts";
import { approvalAnswerError } from "../src/components/DesktopCompanionSurface.tsx";
import { notificationPresentation } from "../src/companion-notification.ts";
import { CapriConversation, excerpt, confirmationAction, overlayMask, pendingApproval, createOverlayPublisher } from "../src/capri3d/conversation.tsx";
import { readFileSync } from "node:fs";
const voice=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(),cancel:vi.fn(),typed:vi.fn(),sent:vi.fn(),draftTaken:vi.fn(),phase:"idle",mic:{available:true,reason:undefined as string | undefined}}));
vi.mock("../src/useVoice.ts",()=>({useVoice:()=>voice}));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();voice.phase="idle";voice.mic={available:true,reason:undefined};});
it("enters once per question, points only with a target and clears on withdrawal",()=>{
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const question={id:"question:q",paneId:"p",sessionId:"s"};
 const view=render(<CapriConversation {...props} question={question}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','true');
 expect(screen.getByText('SEÑALO')).toBeVisible();
 expect(view.container.querySelector('.capri3d-pointing')).toBeNull();
 fireEvent.animationEnd(view.container.querySelector('.capri3d-question')!);
 const target={rect:{x:-500,y:100,width:300,height:400},label:'π - portal_b2b'};
 view.rerender(<CapriConversation {...props} question={{...question,target}}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','false');
 expect(view.container.querySelector('.capri3d-pointing line')).not.toBeNull();
 expect(screen.getByText('π - portal_b2b')).toBeVisible();
 view.rerender(<CapriConversation {...props}/>);
 expect(view.container.querySelector('.capri3d-question')).toBeNull();
 view.rerender(<CapriConversation {...props} question={question}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','false');
 view.rerender(<CapriConversation {...props} question={{...question,id:'question:next'}}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','true');
});
it('consumes entrances across hidden/unmounted surfaces without timers or replay',()=>{
 vi.useFakeTimers();
 const enteredQuestions=new Set<string>();
 const question={id:'question:once',paneId:'p',sessionId:'s'};
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),question,enteredQuestions};
 const view=render(<CapriConversation {...props}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','true');
 view.rerender(<CapriConversation {...props} visible={false}/>);
 expect(view.container.querySelector('.capri3d-question')).toBeNull();
 expect(vi.getTimerCount()).toBe(0);
 view.unmount();
 const resumed=render(<CapriConversation {...props}/>);
 expect(resumed.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','false');
 resumed.unmount();
 const reduced=render(<CapriConversation {...props} question={{...question,id:'question:reduced'}} reduced/>);
 expect(reduced.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','false');
 expect(vi.getTimerCount()).toBe(0);
});
it("keeps reduced pointing static, cancels hidden entrance and never intercepts approval buttons",async()=>{
 vi.useFakeTimers();
 const props={state:initialState,send:vi.fn(),open:true,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const ask={id:'q',paneId:'p',sessionId:'s',title:'Permiso',message:'Ejecutar',action:'bash',kind:'confirm' as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const question={id:'question:q',paneId:'p',sessionId:'s',target:{rect:{x:400,y:100,width:200,height:200},label:'Portal'}};
 const answer=vi.fn().mockResolvedValue(undefined);
 const view=render(<CapriConversation {...props} question={question} reduced approval={ask} answer={answer}/>);
 const layer=view.container.querySelector('.capri3d-question')!;
 expect(layer).toHaveAttribute('data-entering','false');
 expect(layer).toHaveStyle({pointerEvents:'none'});
 expect(layer.querySelector('button,input')).toBeNull();
 expect(layer.contains(screen.getByRole('button',{name:'Aprobar'}))).toBe(false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Aprobar'})));
 expect(answer).toHaveBeenCalledOnce();
 expect(view.container.querySelector('.capri3d-question')).toBeNull();
 view.rerender(<CapriConversation {...props} question={{...question,id:'question:hide'}} visible={false}/>);
 expect(view.container.querySelector('.capri3d-question')).toBeNull();
 view.rerender(<CapriConversation {...props} question={{...question,id:'question:hide'}}/>);
 expect(view.container.querySelector('.capri3d-question')).toHaveAttribute('data-entering','false');
 const css=readFileSync(`${process.cwd()}/packages/ui/src/capri3d/conversation.css`,'utf8');
 expect(css).toContain('capri3d-question-in 300ms');
 expect(css).toContain('.capri3d-question[data-reduced-motion="true"]');
});
it("plays victory layers once, then reveals the supplied completion summary",()=>{
 vi.useFakeTimers();
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const outcome={kind:"done" as const,at:Date.now()};
 const view=render(<CapriConversation {...props}/>);
 expect(view.container.querySelector(".capri3d-outcome")).toBeNull();
 view.rerender(<CapriConversation {...props} outcome={outcome} speech={{id:"done",text:"Cambio listo"}}/>);
 expect(view.container.querySelector(".capri3d-speed-lines")).not.toBeNull();
 expect(view.container.querySelector(".capri3d-shockwave")).not.toBeNull();
 expect(screen.queryByText("Cambio listo")).toBeNull();
 act(()=>vi.advanceTimersByTime(700));
 expect(view.container.querySelector(".capri3d-outcome")).toBeNull();
 expect(screen.getByText("Cambio listo")).toBeVisible();
});
it("shows the actual error with a 120ms red impact and cleans up on hiding",()=>{
 vi.useFakeTimers();
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const outcome={kind:"error" as const,at:Date.now()};
 const view=render(<CapriConversation {...props} outcome={outcome} speech={{id:"err",text:"La compilación falló"}}/>);
 expect(view.container.querySelector(".capri3d-impact")).not.toBeNull();
 expect(view.container.querySelector(".capri3d-speed-lines")).toBeNull();
 expect(screen.getByText("La compilación falló")).toBeVisible();
 act(()=>vi.advanceTimersByTime(120));
 expect(view.container.querySelector(".capri3d-impact")).toBeNull();
 view.rerender(<CapriConversation {...props} outcome={outcome} visible={false}/>);
 expect(view.container.querySelector(".capri3d-outcome")).toBeNull();
 expect(vi.getTimerCount()).toBe(0);
 act(()=>vi.advanceTimersByTime(1000));
 view.rerender(<CapriConversation {...props} outcome={outcome}/>);
 expect(view.container.querySelector(".capri3d-outcome")).toBeNull();
});
it("cancels an in-flight victory while occluded and never replays that episode",()=>{
 vi.useFakeTimers();
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const outcome={kind:"done" as const,at:Date.now()};
 const view=render(<CapriConversation {...props} outcome={outcome}/>);
 expect(vi.getTimerCount()).toBe(1);
 view.rerender(<CapriConversation {...props} outcome={outcome} visible={false}/>);
 expect(vi.getTimerCount()).toBe(0);
 view.rerender(<CapriConversation {...props} outcome={outcome}/>);
 expect(view.container.querySelector(".capri3d-outcome")).toBeNull();
 expect(vi.getTimerCount()).toBe(0);
});
it.each(["done","error"] as const)("uses no FX timers or flash for reduced-motion %s",kind=>{
 vi.useFakeTimers();
 const view=render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} outcome={{kind,at:Date.now()}} reduced/>);
 expect(view.container.querySelector(".capri3d-outcome")).toHaveAttribute("data-reduced-motion","true");
 expect(view.container.querySelector(".capri3d-impact")).toBeNull();
 expect(vi.getTimerCount()).toBe(0);
});
it("uses instant reduced-motion states and leaves approval and composer hit areas intact",()=>{
 vi.useFakeTimers();
 const props={state:initialState,send:vi.fn(),open:true,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const outcome={kind:"done" as const,at:Date.now()};
 const ask={id:"fx",paneId:"p",sessionId:"s",title:"Permiso",message:"Ejecutar",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const answer=vi.fn().mockResolvedValue(undefined);
 const view=render(<CapriConversation {...props} outcome={outcome} reduced approval={ask} answer={answer}/>);
 const fx=view.container.querySelector(".capri3d-outcome")!;
 expect(fx).toHaveAttribute("data-reduced-motion","true");
 expect(fx).toHaveStyle({pointerEvents:"none"});
 expect(fx.querySelector("button, input")).toBeNull();
 expect(fx.contains(screen.getByRole("button",{name:"Aprobar"}))).toBe(false);
 expect(fx.contains(screen.getByRole("textbox"))).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"Aprobar"}));expect(answer).toHaveBeenCalledOnce();
 const css=readFileSync(`${process.cwd()}/packages/ui/src/capri3d/conversation.css`,"utf8");
 expect(css).toContain("repeating-conic-gradient");
 expect(css).toContain('.capri3d-outcome[data-reduced-motion="true"]');
});
it("shows working actions, counts quiet seconds and speaks once per thinking episode",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
 const say=vi.fn(),layout=vi.fn();
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:layout,onThinkingSpeech:say};
 const activity={phase:"working" as const,lastAction:{verb:"EDITO",subject:"gigs.ts",at:new Date().toISOString()}};
 const view=render(<CapriConversation {...props} activity={activity} episodeKey="s1"/>);
 expect(screen.getByText("EDITO gigs.ts")).toBeVisible();expect(layout).toHaveBeenLastCalledWith(true,false);
 act(()=>vi.advanceTimersByTime(14_000));expect(screen.queryByText(/PIENSO/)).toBeNull();
 act(()=>vi.advanceTimersByTime(1000));expect(screen.getByText("PIENSO… 15s")).toHaveAttribute("data-thinking","true");
 act(()=>vi.advanceTimersByTime(24_000));expect(say).not.toHaveBeenCalled();
 act(()=>vi.advanceTimersByTime(1000));expect(say).toHaveBeenCalledExactlyOnceWith("Lo estoy pensando con calma.");
 view.rerender(<CapriConversation {...props} activity={{...activity}} episodeKey="s1"/>);
 act(()=>vi.advanceTimersByTime(80_000));expect(say).toHaveBeenLastCalledWith("No está trabada, está pensando");expect(say).toHaveBeenCalledTimes(2);
 act(()=>vi.advanceTimersByTime(120_000));expect(say).toHaveBeenCalledTimes(2);
 const next={...activity,lastAction:{verb:"EJECUTO",subject:"npm test",at:new Date().toISOString()}};
 view.rerender(<CapriConversation {...props} activity={next} episodeKey="s1"/>);
 expect(screen.getByText("EJECUTO npm test")).toBeVisible();expect(screen.queryByText(/PIENSO/)).toBeNull();
 act(()=>vi.advanceTimersByTime(40_000));expect(say).toHaveBeenCalledTimes(3);
 view.rerender(<CapriConversation {...props} activity={{...next,phase:"waiting"}} episodeKey="s1"/>);
 expect(screen.queryByText(/PIENSO|EJECUTO/)).toBeNull();expect(layout).toHaveBeenLastCalledWith(false,false);
 act(()=>vi.advanceTimersByTime(120_000));expect(say).toHaveBeenCalledTimes(3);
});
it("preserves legacy behavior without action metadata and hides nonworking chips",()=>{
 vi.useFakeTimers();const say=vi.fn();
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),onThinkingSpeech:say};
 const view=render(<CapriConversation {...props} activity={{phase:"working"}}/>);
 act(()=>vi.advanceTimersByTime(150_000));expect(screen.queryByText(/PIENSO/)).toBeNull();expect(say).not.toHaveBeenCalled();
 for(const phase of ["idle","typing","submitted","waiting","unknown"] as const){
  view.rerender(<CapriConversation {...props} activity={{phase,lastAction:{verb:"LEO",subject:"gigs.ts",at:new Date().toISOString()}}}/>);
  expect(screen.queryByText("LEO gigs.ts")).toBeNull();
 }
});
it("uses short excerpts, Ver más and timed speech",()=>{
 vi.useFakeTimers();const more=vi.fn(),layout=vi.fn();
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={{id:"r",text:"A".repeat(300)}} more={more} onLayout={layout}/>);
 expect(excerpt("abc")).toBe("abc");expect(screen.getByText(/A…/).textContent!.length).toBeLessThanOrEqual(161);
 fireEvent.click(screen.getByText("Ver más"));expect(more).toHaveBeenCalledOnce();expect(layout).toHaveBeenLastCalledWith(true,false);
 act(()=>vi.advanceTimersByTime(9000));expect(screen.queryByRole("status")).toBeNull();expect(layout).toHaveBeenLastCalledWith(false,false);
});
it.each(["Captura tomada y copiada", "Captura guardada"])("shows only the minimal screenshot line: %s",(text)=>{
 const speech={id:"screenshot",text,showMore:false,confirmation:true};
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={speech} more={vi.fn()} onLayout={vi.fn()}/>);
 expect(screen.getByRole("status")).toHaveTextContent(text);
 expect(screen.getByRole("status").textContent).toBe(`${text}✓`);
 expect(screen.queryByRole("button",{name:"Ver más"})).toBeNull();
});
it("sends typed text via Dot send and calls the existing mic hook",()=>{
 const send=vi.fn().mockReturnValue(true);
 render(<CapriConversation state={{...initialState,connection:"open"}} send={send} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()}/>);
 fireEvent.change(screen.getByPlaceholderText("Escríbele a Capri…"),{target:{value:"hola Dot"}});fireEvent.click(screen.getByRole("button",{name:"Enviar"}));
 expect(send).toHaveBeenCalledWith({type:"send",text:"hola Dot",requestId:expect.any(String)});
 fireEvent.click(screen.getByRole("button",{name:"Hablar"}));expect(voice.start).toHaveBeenCalledOnce();
});
it("opens history separately without sending or changing the quick draft",()=>{
 const send=vi.fn(),more=vi.fn();
 render(<CapriConversation state={{...initialState,connection:"open"}} send={send} open close={vi.fn()} more={more} onLayout={vi.fn()}/>);
 const input=screen.getByRole("textbox");
 const history=screen.getByRole("button",{name:"Historial"});
 expect(history).toHaveAttribute("type","button");
 expect(history.querySelector("svg")).not.toBeNull();
 fireEvent.change(input,{target:{value:"subí un issue a GitHub"}});
 expect(screen.queryByRole("button",{name:"Historial"})).toBeNull();
 fireEvent.change(input,{target:{value:""}});
 const restored=screen.getByRole("button",{name:"Historial"});
 expect(restored.closest(".capri3d-quick-row")).not.toBeNull();
 fireEvent.click(restored);
 expect(more).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();expect(input).toHaveValue("");
});
it("sends the exact quick contract on Enter, clears and restores focus without opening history",()=>{
 const send=vi.fn().mockReturnValue(true),more=vi.fn();
 render(<CapriConversation state={{...initialState,connection:"open"}} send={send} open close={vi.fn()} more={more} onLayout={vi.fn()}/>);
 const input=screen.getByRole("textbox");
 fireEvent.change(input,{target:{value:"  subí un issue a GitHub  "}});
 fireEvent.keyDown(input,{key:"Enter"});
 expect(send).toHaveBeenCalledExactlyOnceWith({type:"send",text:"subí un issue a GitHub",requestId:expect.any(String)});
 expect(input).toHaveValue("");expect(input).toHaveFocus();expect(more).not.toHaveBeenCalled();
});
it("continues quick message turns after Capri replies without opening history",()=>{
 const send=vi.fn().mockReturnValue(true),more=vi.fn(),close=vi.fn();
 const props={state:{...initialState,connection:"open" as const},send,open:true,close,more,onLayout:vi.fn()};
 const view=render(<CapriConversation {...props}/>);
 const input=screen.getByRole("textbox");
 expect(screen.getByRole("button",{name:"Enviar"})).toBeDisabled();
 fireEvent.change(input,{target:{value:"hola"}});fireEvent.keyDown(input,{key:"Enter"});
 view.rerender(<CapriConversation {...props} speech={{id:"reply",text:"Hola, ¿qué hacemos?"}}/>);
 expect(screen.getByRole("status")).toHaveTextContent("Hola, ¿qué hacemos?");
 expect(input).toHaveFocus();
 fireEvent.change(input,{target:{value:"creá un issue"}});fireEvent.keyDown(input,{key:"Enter"});
 expect(send).toHaveBeenCalledTimes(2);
 expect(send).toHaveBeenLastCalledWith({type:"send",text:"creá un issue",requestId:expect.any(String)});
 expect(input).toHaveValue("");expect(input).toHaveFocus();
 expect(more).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 fireEvent.keyDown(input,{key:"Escape"});expect(voice.cancel).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
});
it("keeps gestures available behind a secondary action, outside the quick row",()=>{
 const onGesture=vi.fn();
 render(<CapriConversation state={initialState} send={vi.fn()} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} onGesture={onGesture}/>);
 expect(screen.queryByRole("combobox",{name:"Gesto de Capri"})).toBeNull();
 expect(screen.getByRole("button",{name:"Gestos de Capri"}).closest(".capri3d-chat-header")).not.toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Gestos de Capri"}));
 const select=screen.getByRole("combobox",{name:"Gesto de Capri"});
 expect(select.closest(".capri3d-quick-row")).toBeNull();
 fireEvent.change(select,{target:{value:(select as HTMLSelectElement).options[1]!.value}});
 expect(onGesture).toHaveBeenCalledOnce();
});
it.each(["recording","transcribing"])("labels the mic and feedback while %s",phase=>{
 voice.phase=phase;
 render(<CapriConversation state={initialState} send={vi.fn()} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()}/>);
 const mic=screen.getByRole("button",{name:phase==="recording"?"Terminar dictado":"Transcribiendo audio"});
 expect(mic).toHaveAttribute("data-recording",String(phase==="recording"));
 expect(screen.getByRole("status")).toHaveTextContent(phase==="recording"?"Escuchando…":"Transcribiendo…");
 if(phase==="recording"){fireEvent.click(mic);expect(voice.stop).toHaveBeenCalledOnce();}else expect(mic).toBeDisabled();
});
it("preserves the unavailable mic reason and close cancellation",()=>{
 voice.mic={available:false,reason:"Micrófono no disponible"};const close=vi.fn();
 render(<CapriConversation state={initialState} send={vi.fn()} open close={close} more={vi.fn()} onLayout={vi.fn()}/>);
 expect(screen.getByRole("button",{name:"Hablar"})).toBeDisabled();
 expect(screen.getByRole("button",{name:"Hablar"})).toHaveAttribute("title","Micrófono no disponible");
 const closeButton=screen.getByRole("button",{name:"Cerrar entrada"});
 expect(closeButton.closest(".capri3d-chat-header")).not.toBeNull();
 expect(closeButton.closest(".capri3d-quick-row")).toBeNull();
 fireEvent.click(closeButton);expect(voice.cancel).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
});
it("answers only answerable confirm dialogs using exact existing identity and action",()=>{
 const ask={id:"q",paneId:"p",sessionId:"s",title:"¿Continuar?",message:"Permiso",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 expect(confirmationAction(ask,true)).toEqual({action:"answer",paneId:"p",sessionId:"s",requestId:"q",approved:true});
 expect(confirmationAction({...ask,kind:"select"},true)).toBeUndefined();expect(confirmationAction({...ask,answerable:false},true)).toBeUndefined();
 expect(confirmationAction({...ask,expiresAt:"invalid"},true)).toBeUndefined();expect(confirmationAction({...ask,expiresAt:new Date(0).toISOString()},true)).toBeUndefined();
 const answer=vi.fn().mockResolvedValue(undefined);
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 fireEvent.click(screen.getByRole("button",{name:"Rechazar"}));expect(answer).toHaveBeenCalledWith({action:"answer",paneId:"p",sessionId:"s",requestId:"q",approved:false});
});
it("withdraws decision buttons on expiry without authorizing an answer",()=>{
 vi.useFakeTimers();const answer=vi.fn();
 const ask={id:"expires",paneId:"p",sessionId:"s",title:"Permiso",message:"Ejecutar",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1000).toISOString(),answerable:true};
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 expect(screen.getByRole("button",{name:"Aprobar"})).toBeEnabled();
 act(()=>vi.advanceTimersByTime(1000));
 expect(screen.queryByRole("button",{name:"Aprobar"})).toBeNull();expect(screen.queryByRole("button",{name:"Rechazar"})).toBeNull();expect(answer).not.toHaveBeenCalled();
});
it("keeps a failed send in the input and explains the failure",()=>{
 render(<CapriConversation state={{...initialState,connection:"open"}} send={vi.fn().mockReturnValue(false)} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()}/>);
 const input=screen.getByPlaceholderText("Escríbele a Capri…");
 fireEvent.change(input,{target:{value:"conservame"}});fireEvent.click(screen.getByRole("button",{name:"Enviar"}));
 expect(input).toHaveValue("conservame");expect(screen.getByText("Sin conexión. Tu mensaje sigue aquí.")).toBeInTheDocument();
});
it("includes only rendered overlays and transformed silhouette in the expanded mask",()=>{
 const mask=overlayMask(Array(816).fill(0),true,true);expect(mask).toHaveLength(816);expect(mask[1*24+12]).toBe(1);expect(mask[33*24+12]).toBe(1);expect(mask[15*24]).toBe(0);
 expect(overlayMask(Array(816).fill(0),false,false).every(x=>x===0)).toBe(true);
});
it("reprojects the compact 144x204 body into the expanded surface",()=>{
 const body=Array(816).fill(0);body[17*24+12]=1;
 const mask=overlayMask(body,true,false);
 expect(mask[24*24+12]).toBe(1);expect(mask[30*24+12]).toBe(0);
});

it("shows pending feedback and sends a rapid decision only once", async()=>{
 const ask={id:"pending",paneId:"p",sessionId:"s",title:"Permiso",message:"Ejecutar",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 const yes=screen.getByRole("button",{name:"Aprobar"});fireEvent.click(yes);fireEvent.click(yes);
 expect(answer).toHaveBeenCalledOnce();expect(screen.getByText("Enviando respuesta…")).toBeInTheDocument();
 await act(async()=>finish());expect(screen.getByText("Respuesta enviada")).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Aprobar"})).toBeNull();
});

it("does not hide a new session's permission when the old answer completes", async()=>{
 const ask={id:"q",paneId:"p",sessionId:"old",title:"Old permission",message:"Execute",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 let finish!:()=>void; const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),answer};
 const view=render(<CapriConversation {...props} approval={ask}/>);
 fireEvent.click(screen.getByRole("button",{name:"Aprobar"}));
 view.rerender(<CapriConversation {...props} approval={{...ask,sessionId:"new",title:"New permission"}}/>);
 await act(async()=>finish());
 expect(screen.getByText(/New permission/)).toBeInTheDocument();
 expect(screen.queryByText("Respuesta enviada")).toBeNull();
 expect(screen.getByRole("button",{name:"Aprobar"})).toBeEnabled();
});
it("keeps a failed decision available for an explicit retry",async()=>{
 const ask={id:"retry",paneId:"p",sessionId:"s",title:"Retry",message:"Execute",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const answer=vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Rechazar"})));
 expect(screen.getByRole("alert")).toHaveTextContent("No se pudo responder");
 expect(answer).toHaveBeenCalledTimes(1);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Rechazar"})));
 expect(answer).toHaveBeenCalledTimes(2);expect(screen.getByText("Respuesta enviada")).toBeInTheDocument();
});

it("does not resurrect permission speech after receipt or lose receipt when permission disappears",async()=>{
 vi.useFakeTimers();
 const ask={id:"speech",paneId:"p",sessionId:"s",title:"Permission",message:"Run command",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),answer:vi.fn().mockResolvedValue(undefined),speech:{id:"question:speech",text:"Permission Run command",approvalKey:JSON.stringify(["p","s","speech"])}};
 const view=render(<CapriConversation {...props} approval={ask}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Aprobar"})));
 view.rerender(<CapriConversation {...props}/>);
 expect(screen.getByText("Respuesta enviada")).toBeInTheDocument();
 act(()=>vi.advanceTimersByTime(1500));
 expect(screen.queryByText("Permission Run command")).toBeNull();
 expect(screen.queryByRole("button",{name:"Ver más"})).toBeNull();
});

it("preserves another session's same-ID speech after an in-flight answer",async()=>{
 vi.useFakeTimers();
 const ask={id:"q",paneId:"p",sessionId:"a",title:"A",message:"Execute",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),answer};
 const view=render(<CapriConversation {...props} approval={ask}/>);
 fireEvent.click(screen.getByRole("button",{name:"Aprobar"}));
 view.rerender(<CapriConversation {...props} speech={{id:"question:q",text:"Other session request",approvalKey:JSON.stringify(["p","b","q"])}}/>);
 await act(async()=>finish());act(()=>vi.advanceTimersByTime(1500));
 expect(screen.getByText("Other session request")).toBeInTheDocument();
 expect(answer).toHaveBeenCalledOnce();
});

it("shows question notice without any respond affordance on desktop",()=>{
 const more=vi.fn(),answer=vi.fn(),send=vi.fn();
 render(<CapriConversation state={initialState} send={send} open={false} close={vi.fn()} speech={{id:"question:q",text:"Portal B2B tiene una pregunta.",question:true}} more={more} answer={answer} onLayout={vi.fn()}/>);
 expect(screen.getByText("Portal B2B tiene una pregunta.")).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Responder"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Ver más"})).toBeNull();
 expect(more).not.toHaveBeenCalled();expect(answer).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});
it("marks a session completion without decorating an ordinary reply",()=>{
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn()};
 const view=render(<CapriConversation {...props} speech={{id:"done",text:"La sesión terminó.",confirmation:true}}/>);
 expect(view.container.querySelector(".capri3d-check")).toHaveTextContent("✓");
 view.rerender(<CapriConversation {...props} speech={{id:"reply",text:"Hola"}}/>);
 expect(view.container.querySelector(".capri3d-check")).toBeNull();
});
it("never bolds a text-inferred sender from the Chrome error counterexample",()=>{
 const body="Acceso denegado: vuelve a iniciar sesión";
 const message=notificationPresentation({id:"chrome-error",kind:"notification",expiresAt:Date.now()+8000,source:{appName:"Chrome"},summary:"Nuevo mensaje en #ops",body});
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={{...message,id:"chrome-error",text:`${message.summary} ${message.body}`}} more={vi.fn()} onLayout={vi.fn()}/>);
 expect(screen.getByRole("status").querySelector("strong")).toBeNull();
 expect(screen.getByRole("status")).toHaveTextContent(body);
 expect(message.body).toBe(body);
 expect(message.sender).toBeUndefined();
 expect(message.channel).toBeUndefined();
 expect(message.privateMessage).toBeUndefined();
});
it("renders sender metadata separately from quoted message text",()=>{
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={{id:"slack",text:"Leslie te escribió. ¿Me ayudas?",sender:"Leslie",channel:"#distribución",body:"¿Me ayudas?"}} more={vi.fn()} onLayout={vi.fn()}/>);
 expect(screen.getByText("Leslie").tagName).toBe("STRONG");
 expect(screen.getByText("#distribución")).toHaveClass("capri3d-channel");
 expect(screen.getByRole("status")).toHaveTextContent("¿Me ayudas?");
});
it("reuses the body mask and only publishes changed overlay masks/layouts",()=>{
 const publish=vi.fn();const update=createOverlayPublisher(publish);
 const body=Array(816).fill(0);body[400]=1;
 update(body,false,false);update([...body],false,false);
 update(body,true,false);update([...body],true,false);
 update(body,false,false);update(body,false,false);
 expect(publish).toHaveBeenCalledTimes(3);
 expect(publish.mock.calls[0]![0]).toBe(body);
 expect(publish.mock.calls[2]![0]).toBe(body);
 expect(publish.mock.calls[1]![1]).toEqual({bubble:true,input:false});
});

it("surfaces the real failure reason when an answer no longer matches",async()=>{
 const ask={id:"gone",paneId:"p",sessionId:"s",title:"Permiso",message:"Ejecutar",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const answer=vi.fn().mockRejectedValue(new Error("La pregunta cambió"));
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Aprobar"})));
 expect(screen.getByRole("alert")).toHaveTextContent("La pregunta cambió");
});
it.each([
 ["boom /home/secret", "No se pudo responder con la sesión. Volvé a intentarlo o abrí el panel."],
 ["Esta solicitud venció. Actualiza la sesión antes de responder.", "No se pudo responder: Esta solicitud venció. Actualiza la sesión antes de responder."],
])("displays normalized parent answer failure: %s",async(message,expected)=>{
 const ask={id:"failure",paneId:"p",sessionId:"s",title:"Permiso",message:"Ejecutar",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const client={act:vi.fn().mockRejectedValue(new Error(message))};
 const answer=async()=>{try{await client.act();}catch(error){throw approvalAnswerError(error);}};
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Aprobar"})));
 expect(client.act).toHaveBeenCalledOnce();
 expect(screen.getByRole("alert").textContent).toBe(expected);
 expect(screen.getByRole("alert")).not.toHaveTextContent("boom");
 expect(screen.getByRole("alert")).not.toHaveTextContent("/home/secret");
});
it("pendingApproval keeps only a live, exact, answerable confirm",()=>{
 const now=Date.now();
 const a={id:"q1",paneId:"p",sessionId:"s",title:"t",message:"m",action:"x",kind:"confirm" as const,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),answerable:true};
 const cue={id:"question:q1",paneId:"p",sessionId:"s"};
 expect(pendingApproval([a],cue)?.id).toBe("q1");
 expect(pendingApproval([],cue)).toBeUndefined();
 expect(pendingApproval([a],{...cue,id:"question:other"})).toBeUndefined();
 expect(pendingApproval([{...a,kind:"select"}],cue)).toBeUndefined();
 expect(pendingApproval([{...a,expiresAt:"invalid"}],cue)).toBeUndefined();
 vi.spyOn(Date,"now").mockReturnValue(now);
 expect(pendingApproval([{...a,expiresAt:new Date(now).toISOString()}],cue)).toBeUndefined();
 vi.mocked(Date.now).mockRestore();
 expect(pendingApproval([{...a,answerable:false}],cue)).toBeUndefined();
 expect(pendingApproval([{...a,expiresAt:new Date(now-1000).toISOString()}],cue)).toBeUndefined();
 expect(pendingApproval([{...a,paneId:"other"}],cue)).toBeUndefined();
 expect(pendingApproval([{...a,sessionId:"other"}],cue)).toBeUndefined();
});

it("collapses the Historial block while typing and restores it when empty",()=>{
 const more=vi.fn();
 render(<CapriConversation state={{...initialState,connection:"open"}} send={vi.fn()} open close={vi.fn()} more={more} onLayout={vi.fn()}/>);
 const input=screen.getByPlaceholderText(/a Capri/);
 expect(screen.getByRole("button",{name:"Historial"})).toBeInTheDocument();
 fireEvent.change(input,{target:{value:"subí un issue"}});
 expect(screen.queryByRole("button",{name:"Historial"})).toBeNull();
 fireEvent.change(input,{target:{value:""}});
 expect(screen.getByRole("button",{name:"Historial"})).toBeInTheDocument();
});
