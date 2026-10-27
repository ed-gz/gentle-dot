// Ported from https://github.com/mochiiwuff/capri-desktop (MIT).
// fx.js essentials, scoped to our native body window; no full-screen overlay or own rAF.
const C={red:'#ff2152',green:'#36ff7a',ink:'#14101c',violet:'#7b3dff',paper:'#fff4f6'};
const rand=(a:number,b:number)=>a+Math.random()*(b-a);
const pick=<T,>(xs:T[])=>xs[Math.floor(Math.random()*xs.length)]!;
type Kind='shard'|'slice'|'lines'|'ring'|'bolt'|'cutin'|'reticle';
interface Item {kind:Kind;born:number;life:number;x:number;y:number;vx?:number;vy?:number;rot?:number;vr?:number;len?:number;wid?:number;color?:string;inward?:boolean;image?:HTMLImageElement;strokes?:{a:number;w:number;r0:number;color:string}[];drawn?:number}
export class RigFx {
 private readonly ctx: CanvasRenderingContext2D;
 private items: Item[]=[];
 private last=0;
 readonly cutins: Partial<Record<'grin'|'laugh'|'eyes',HTMLImageElement>>={};
 readonly canvas:HTMLCanvasElement;
 constructor(canvas:HTMLCanvasElement) {
  this.canvas=canvas;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('FX canvas unavailable');this.ctx=ctx;
  canvas.width=352;canvas.height=532;
 }
 clear(){this.items=[];this.last=0;this.ctx.clearRect(0,0,352,532);}
 private add(kind:Kind,now:number,life:number,x=174,y=210,extra:Partial<Item>={}) {this.items.push({kind,born:now,life,x,y,...extra});}
 burst(now:number,inward=false,{count=22,power=1,spread=70}={}){
  for(let i=0;i<count;i++){
   const a=rand(0,Math.PI*2),speed=rand(220,680)*power,life=rand(260,620);
   const x=174+rand(-spread,spread)*.5,y=148+rand(-spread,spread);
   this.add('shard',now,life,inward?x+Math.cos(a)*speed*life/1600:x,inward?y+Math.sin(a)*speed*life/1600:y,
    {vx:Math.cos(a)*speed*(inward?-1:1),vy:Math.sin(a)*speed*(inward?-1:1),rot:rand(0,Math.PI*2),vr:rand(-9,9),len:rand(10,36),wid:rand(3,10),color:pick([C.red,C.red,C.red,C.red,C.ink,C.ink,C.green,C.green,C.violet,C.paper])});
  }
 }
 cue(cue:string,now:number,dir=1){
  if(cue==='gather')this.burst(now,true,{count:18,power:.7,spread:170});
  if(cue==='launch'||cue==='vanish'){
   for(let i=0;i<5;i++)this.add('slice',now,rand(96,160),104+rand(-51,51),148+rand(0,300),{len:rand(51,187),wid:rand(2,7),vx:rand(-60,60),color:pick([C.red,C.green,C.violet,C.paper])});
  }
  if(cue==='arrive'){this.burst(now,false,{count:10,power:.55,spread:110});this.add('ring',now,280,174,148);}
  if(cue==='peak'){this.add('lines',now,480,174,148);this.add('ring',now,280,174,148);this.burst(now,false,{count:34,power:1.2,spread:140});}
  if(cue==='laugh')this.cutin(this.cutins.laugh?'laugh':'grin',now);
  if(cue==='coil')this.burst(now,true,{count:10,power:.45,spread:90});
  if(cue==='lock'){
   this.add('bolt',now,260,dir>0?268:84,228);
   this.add('reticle',now,480,dir>0?316:36,182);
   this.cutin('eyes',now);
  }
  if(cue==='tap')this.add('reticle',now,480,dir>0?316:36,182);
 }
 private cutin(kind:'grin'|'laugh'|'eyes',now:number){
  const image=this.cutins[kind];if(image)this.add('cutin',now,760,34,130,{image});
 }
 private stroke(pts:number[][],color:string,width:number,dx=0,dy=0){
  const g=this.ctx;g.beginPath();pts.forEach(([x,y],i)=>i?g.lineTo(x!+dx,y!+dy):g.moveTo(x!+dx,y!+dy));g.strokeStyle=color;g.lineWidth=width;g.stroke();
 }
 draw(now:number){
  if(!this.items.length || now-this.last<1000/24-1)return;
  const dt=Math.min(.08,(now-(this.last||now))/1000);this.last=now;
  const g=this.ctx;g.clearRect(0,0,352,532);
  this.items=this.items.filter(it=>now-it.born<it.life);
  for(const it of this.items){
   const t=(now-it.born)/it.life,frame=Math.floor((now-it.born)*24/1000);
   g.save();g.lineJoin='miter';
   switch(it.kind){
    case 'shard':{
     it.x+=it.vx!*dt;it.y+=it.vy!*dt;it.vx!*=.86;it.vy!*=.86;it.rot!+=it.vr!*dt;
     const k=t<.7?1:1-(t-.7)/.3,len=it.len!*k,wid=it.wid!*k;
     g.translate(it.x,it.y);g.rotate(it.rot!);
     for(const [dx,dy,color] of [[-2,2,C.violet],[0,0,it.color!]] as const){
      g.beginPath();g.moveTo(-len*.5+dx,dy);g.lineTo(dx,-wid*.5+dy);g.lineTo(len*.5+dx,wid*.15+dy);g.lineTo(-len*.1+dx,wid*.5+dy);g.closePath();g.fillStyle=color;g.fill();
     }break;
    }
    case 'slice':{
     g.globalAlpha=1-t;g.fillStyle=it.color!;g.fillRect(it.x+it.vx!*t,it.y,it.len!,it.wid!);break;
    }
    case 'lines':{
     if(!it.strokes||it.drawn!==(frame>>1)){
      it.drawn=frame>>1;it.strokes=Array.from({length:32},()=>({a:rand(0,Math.PI*2),w:rand(.008,.026),r0:140*rand(1,1.6),color:pick([C.paper,C.paper,C.paper,C.violet,C.red])}));
     }
     g.globalAlpha=t>.7?1-Math.floor((t-.7)/.3*3)/3:1;
     for(const s of it.strokes){const outer=504;g.beginPath();g.moveTo(it.x+Math.cos(s.a-s.w)*outer,it.y+Math.sin(s.a-s.w)*outer);g.lineTo(it.x+Math.cos(s.a)*s.r0,it.y+Math.sin(s.a)*s.r0);g.lineTo(it.x+Math.cos(s.a+s.w)*outer,it.y+Math.sin(s.a+s.w)*outer);g.closePath();g.fillStyle=s.color;g.fill();}break;
    }
    case 'ring':{
     const k=Math.floor(t*6)/6,r=40+230*k;
     for(const [dx,color]of[[-3,C.violet],[0,C.red]]as const){g.beginPath();g.arc(it.x+dx,it.y-dx,r,0,Math.PI*2);g.strokeStyle=color;g.lineWidth=Math.max(1,8*(1-k));g.stroke();}break;
    }
    case 'bolt':{
     if(frame%3===2)break;
     const end={x:it.x>176?316:36,y:182},pts:number[][]=[];
     for(let i=0;i<=9;i++){const u=i/9,off=i===0||i===9?0:rand(7,22)*(i%2?1:-1);pts.push([it.x+(end.x-it.x)*u+off,it.y+(end.y-it.y)*u+off*.3]);}
     this.stroke(pts,C.violet,4,-1.5,1.5);this.stroke(pts,C.red,4);this.stroke(pts,C.paper,1.05);
     for(let f=0;f<2;f++){const [x,y]=pick(pts.slice(1,-1));this.stroke([[x!,y!],[x!+rand(-20,20),y!-15],[x!+rand(-35,35),y!-rand(20,55)]],C.red,1.8);}break;
    }
    case 'reticle':{
     const r=22+8*(1-Math.min(1,t*4));g.strokeStyle=C.red;g.lineWidth=2;
     for(const sx of[-1,1])for(const sy of[-1,1]){g.beginPath();g.moveTo(it.x+sx*(r-9),it.y+sy*r);g.lineTo(it.x+sx*r,it.y+sy*r);g.lineTo(it.x+sx*r,it.y+sy*(r-9));g.stroke();}
     break;
    }
    case 'cutin':{
     const open=t<.06?.3:t<.12?.7:1,tall=t>.9?.12:t>.82?.5:1,w=250*open,h=96*tall,x=it.x,y=it.y-h/2,skew=24;
     const band=(dx:number,dy:number)=>{g.beginPath();g.moveTo(x+skew+dx,y+dy);g.lineTo(x+w+skew+dx,y+dy);g.lineTo(x+w+dx,y+h+dy);g.lineTo(x+dx,y+h+dy);g.closePath();};
     band(6,6);g.fillStyle=C.violet;g.fill();band(0,0);g.fillStyle=C.ink;g.fill();g.clip();
     for(let i=0;i<9;i++){g.fillStyle=i%3?C.red:C.paper;g.fillRect(x+rand(-20,w),y+rand(0,h),rand(30,110),rand(1,3));}
     const zoom=h*1.1/240*(1+t*.08),fw=360*zoom,fh=240*zoom,cx=x+w/2+skew/2+rand(-2,2),cy=y+h/2+rand(-2,2);
     g.drawImage(it.image!,cx-fw/2,cy-fh/2,fw,fh);g.fillStyle=C.red;g.fillRect(x,y,w+skew,3);break;
    }
   }g.restore();
  }
 }
}
