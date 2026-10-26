import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../src/store.ts";
import { CapriConversation, excerpt, confirmationAction, overlayMask } from "../src/capri3d/conversation.tsx";
const voice=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(),cancel:vi.fn(),typed:vi.fn(),sent:vi.fn(),draftTaken:vi.fn(),phase:"idle",mic:{available:true,reason:undefined as string | undefined}}));
vi.mock("../src/useVoice.ts",()=>({useVoice:()=>voice}));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();voice.phase="idle";voice.mic={available:true,reason:undefined};});
it("uses short excerpts, Ver más and timed speech",()=>{
 vi.useFakeTimers();const more=vi.fn(),layout=vi.fn();
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={{id:"r",text:"A".repeat(300)}} more={more} onLayout={layout}/>);
 expect(excerpt("abc")).toBe("abc");expect(screen.getByText(/A…/).textContent!.length).toBeLessThanOrEqual(161);
 fireEvent.click(screen.getByText("Ver más"));expect(more).toHaveBeenCalledOnce();expect(layout).toHaveBeenLastCalledWith(true,false);
 act(()=>vi.advanceTimersByTime(9000));expect(screen.queryByRole("status")).toBeNull();expect(layout).toHaveBeenLastCalledWith(false,false);
});
it.each(["Captura tomada y copiada", "Captura guardada"])("shows only the minimal screenshot line: %s",(text)=>{
 const speech={id:"screenshot",text,showMore:false};
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} speech={speech} more={vi.fn()} onLayout={vi.fn()}/>);
 expect(screen.getByRole("status")).toHaveTextContent(text);
 expect(screen.getByRole("status").textContent).toBe(text);
 expect(screen.queryByRole("button",{name:"Ver más"})).toBeNull();
});
it("sends typed text via Dot send and calls the existing mic hook",()=>{
 const send=vi.fn().mockReturnValue(true);
 render(<CapriConversation state={{...initialState,connection:"open"}} send={send} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()}/>);
 fireEvent.change(screen.getByPlaceholderText("Escribile o hablale…"),{target:{value:"hola Dot"}});fireEvent.click(screen.getByRole("button",{name:"Enviar"}));
 expect(send).toHaveBeenCalledWith({type:"send",text:"hola Dot",requestId:expect.any(String)});
 fireEvent.click(screen.getByRole("button",{name:"Hablar"}));expect(voice.start).toHaveBeenCalledOnce();
});
it("opens history separately without sending or changing the quick draft",()=>{
 const send=vi.fn(),more=vi.fn();
 render(<CapriConversation state={{...initialState,connection:"open"}} send={send} open close={vi.fn()} more={more} onLayout={vi.fn()}/>);
 const input=screen.getByRole("textbox");
 fireEvent.change(input,{target:{value:"subí un issue a GitHub"}});
 expect(more).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Historial"}));
 expect(more).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();expect(input).toHaveValue("subí un issue a GitHub");
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
it("keeps gestures available behind a secondary action, outside the quick row",()=>{
 const onGesture=vi.fn();
 render(<CapriConversation state={initialState} send={vi.fn()} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} onGesture={onGesture}/>);
 expect(screen.queryByRole("combobox",{name:"Gesto de Capri"})).toBeNull();
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
 fireEvent.click(screen.getByRole("button",{name:"Cerrar entrada"}));expect(voice.cancel).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
});
it("answers only answerable confirm dialogs using exact existing identity and action",()=>{
 const ask={id:"q",paneId:"p",sessionId:"s",title:"¿Continuar?",message:"Permiso",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 expect(confirmationAction(ask,true)).toEqual({action:"answer",paneId:"p",sessionId:"s",requestId:"q",approved:true});
 expect(confirmationAction({...ask,kind:"select"},true)).toBeUndefined();expect(confirmationAction({...ask,answerable:false},true)).toBeUndefined();
 expect(confirmationAction({...ask,expiresAt:"invalid"},true)).toBeUndefined();expect(confirmationAction({...ask,expiresAt:new Date(0).toISOString()},true)).toBeUndefined();
 const answer=vi.fn().mockResolvedValue(undefined);
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 fireEvent.click(screen.getByRole("button",{name:"No"}));expect(answer).toHaveBeenCalledWith({action:"answer",paneId:"p",sessionId:"s",requestId:"q",approved:false});
});
it("keeps a failed send in the input and explains the failure",()=>{
 render(<CapriConversation state={{...initialState,connection:"open"}} send={vi.fn().mockReturnValue(false)} open close={vi.fn()} more={vi.fn()} onLayout={vi.fn()}/>);
 const input=screen.getByPlaceholderText("Escribile o hablale…");
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
 const yes=screen.getByRole("button",{name:"Sí"});fireEvent.click(yes);fireEvent.click(yes);
 expect(answer).toHaveBeenCalledOnce();expect(screen.getByText("Enviando respuesta…")).toBeInTheDocument();
 await act(async()=>finish());expect(screen.getByText("Respuesta enviada")).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Sí"})).toBeNull();
});

it("does not hide a new session's permission when the old answer completes", async()=>{
 const ask={id:"q",paneId:"p",sessionId:"old",title:"Old permission",message:"Execute",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 let finish!:()=>void; const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),answer};
 const view=render(<CapriConversation {...props} approval={ask}/>);
 fireEvent.click(screen.getByRole("button",{name:"Sí"}));
 view.rerender(<CapriConversation {...props} approval={{...ask,sessionId:"new",title:"New permission"}}/>);
 await act(async()=>finish());
 expect(screen.getByText(/New permission/)).toBeInTheDocument();
 expect(screen.queryByText("Respuesta enviada")).toBeNull();
 expect(screen.getByRole("button",{name:"Sí"})).toBeEnabled();
});
it("keeps a failed decision available for an explicit retry",async()=>{
 const ask={id:"retry",paneId:"p",sessionId:"s",title:"Retry",message:"Execute",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const answer=vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
 render(<CapriConversation state={initialState} send={vi.fn()} open={false} close={vi.fn()} more={vi.fn()} onLayout={vi.fn()} approval={ask} answer={answer}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"No"})));
 expect(screen.getByRole("alert")).toHaveTextContent("No se pudo responder");
 expect(answer).toHaveBeenCalledTimes(1);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"No"})));
 expect(answer).toHaveBeenCalledTimes(2);expect(screen.getByText("Respuesta enviada")).toBeInTheDocument();
});

it("does not resurrect permission speech after receipt or lose receipt when permission disappears",async()=>{
 vi.useFakeTimers();
 const ask={id:"speech",paneId:"p",sessionId:"s",title:"Permission",message:"Run command",action:"bash",kind:"confirm" as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
 const props={state:initialState,send:vi.fn(),open:false,close:vi.fn(),more:vi.fn(),onLayout:vi.fn(),answer:vi.fn().mockResolvedValue(undefined),speech:{id:"question:speech",text:"Permission Run command",approvalKey:JSON.stringify(["p","s","speech"])}};
 const view=render(<CapriConversation {...props} approval={ask}/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Sí"})));
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
 fireEvent.click(screen.getByRole("button",{name:"Sí"}));
 view.rerender(<CapriConversation {...props} speech={{id:"question:q",text:"Other session request",approvalKey:JSON.stringify(["p","b","q"])}}/>);
 await act(async()=>finish());act(()=>vi.advanceTimersByTime(1500));
 expect(screen.getByText("Other session request")).toBeInTheDocument();
 expect(answer).toHaveBeenCalledOnce();
});
