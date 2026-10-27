import {expect,it,vi} from 'vitest';
import {RigFx} from '../src/capri2d/fx.ts';
function setup(){
 const calls:Record<string,ReturnType<typeof vi.fn>>={};
 const ctx=new Proxy({}, {get(_target,key:string){return calls[key]??=(vi.fn());},set(){return true;}});
 const canvas={getContext:()=>ctx,width:0,height:0}as unknown as HTMLCanvasElement;
 return {fx:new RigFx(canvas),calls};
}
it('ports cue-driven shard gathering, peak speed lines/ring and a local laugh cut-in',()=>{
 const {fx,calls}=setup();
 fx.cue('gather',100);fx.draw(100);
 expect(calls.fill).toHaveBeenCalledTimes(36); // 18 shards, each with violet misregistration.
 fx.clear();
 fx.cue('peak',200);fx.draw(200);
 expect(calls.arc).toHaveBeenCalledTimes(2);
 expect(calls.fill).toHaveBeenCalledTimes(36+32+68); // speed lines + 34 shards.
 fx.cutins.laugh={} as HTMLImageElement;
 fx.cue('laugh',300);fx.draw(300);
 expect(calls.drawImage).toHaveBeenCalledOnce();
 expect(canvasShape(fx.canvas)).toEqual([352,532]);
});
it('draws point bolt/reticle/eyes and clears once expired without an independent animation loop',()=>{
 const {fx,calls}=setup();fx.cutins.eyes={}as HTMLImageElement;
 fx.cue('lock',100,-1);fx.draw(100);
 expect(calls.stroke).toHaveBeenCalled();expect(calls.drawImage).toHaveBeenCalledOnce();
 fx.draw(2000);const cleared=calls.clearRect!.mock.calls.length;
 fx.draw(3000);expect(calls.clearRect).toHaveBeenCalledTimes(cleared);
 fx.clear();expect(calls.clearRect).toHaveBeenLastCalledWith(0,0,352,532);
});
function canvasShape(canvas:HTMLCanvasElement){return[canvas.width,canvas.height];}
