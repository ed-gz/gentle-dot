import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../src/store.ts";
import { CapriConversation, excerpt, confirmationAction, overlayMask } from "../src/capri3d/conversation.tsx";
const voice=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(),typed:vi.fn(),sent:vi.fn(),draftTaken:vi.fn(),phase:"idle",mic:{available:true}}));
vi.mock("../src/useVoice.ts",()=>({useVoice:()=>voice}));
afterEach(()=>vi.useRealTimers());
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
