// Pure geometry shared by the slicer and tests. Right/bottom edges are exclusive.
export function gridCell(width,height,index) {
 if(!Number.isInteger(index)||index<0||index>=16||width<4||height<4)throw new RangeError('Invalid grid');
 const col=index%4,row=Math.floor(index/4),x=Math.floor(col*width/4),y=Math.floor(row*height/4);
 return {x,y,width:Math.floor((col+1)*width/4)-x,height:Math.floor((row+1)*height/4)-y};
}
// Recover small overhangs beyond nominal grid lines; discard neighbouring cell fragments.
export function cutCell(rgba,width,height,index,padding=32) {
 const cell=gridCell(width,height,index),w=cell.width+padding*2,h=cell.height+padding*2;
 const pixels=Buffer.alloc(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
  const sx=cell.x+x-padding,sy=cell.y+y-padding;
  if(sx>=0&&sy>=0&&sx<width&&sy<height)rgba.copy(pixels,(y*w+x)*4,(sy*width+sx)*4,(sy*width+sx+1)*4);
 }
 const seen=new Uint8Array(w*h),keep=new Uint8Array(w*h);
 for(let p=0;p<seen.length;p++) {
  if(seen[p]||pixels[p*4+3]<32)continue;
  const component=[p];seen[p]=1;let sx=0,sy=0;
  for(let j=0;j<component.length;j++) {
   const q=component[j],x=q%w,y=Math.floor(q/w);sx+=x;sy+=y;
   for(const n of [x>0?q-1:-1,x<w-1?q+1:-1,q-w,q+w])if(n>=0&&n<seen.length&&!seen[n]&&pixels[n*4+3]>=32){seen[n]=1;component.push(n);}
  }
  const cx=sx/component.length,cy=sy/component.length;
  if(component.length>=64&&cx>=padding&&cx<padding+cell.width&&cy>=padding&&cy<padding+cell.height)
   for(const q of component)keep[q]=1;
 }
 for(let p=0;p<keep.length;p++)if(!keep[p])pixels.fill(0,p*4,p*4+4);
 return {pixels,width:w,height:h};
}
export function measure(rgba,width,height) {
 let left=width,top=height,right=-1,bottom=-1,eyeLeft=width,eyeRight=-1,eyeTop=height,eyeBottom=-1;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const i=(y*width+x)*4,[r,g,b,a]=rgba.subarray(i,i+4);
  if(a<32)continue;
  left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  // Blue iris bounds, not the silhouette centre: hair/pointing hands must not move the face.
  if(b>140&&b>r*1.3&&b>g*1.2&&a>160) {
   eyeLeft=Math.min(eyeLeft,x);eyeRight=Math.max(eyeRight,x);eyeTop=Math.min(eyeTop,y);eyeBottom=Math.max(eyeBottom,y);
  }
 }
 // Largest connected green region is the mask, not a hand or a stray export speck.
 // Unlike pupil centres this anchor does not follow left/right gaze.
 const visited=new Uint8Array(width*height);let largest=[];
 const green=p=>rgba[p*4+3]>160&&rgba[p*4+1]>120&&rgba[p*4+1]>rgba[p*4]*1.7&&rgba[p*4+1]>rgba[p*4+2]*1.4;
 for(let p=0;p<visited.length;p++) {
  if(visited[p]||!green(p))continue;
  const component=[p];visited[p]=1;
  for(let j=0;j<component.length;j++) {
   const q=component[j],x=q%width;
   for(const n of [x>0?q-1:-1,x<width-1?q+1:-1,q-width,q+width]) {
    if(n>=0&&n<visited.length&&!visited[n]&&green(n)){visited[n]=1;component.push(n);}
   }
  }
  if(component.length>largest.length)largest=component;
 }
 if(right<left)throw new Error('Empty cell');
 if(largest.length>500) {
  let l=width,r=0,t=height,b=0;
  for(const p of largest){const x=p%width,y=Math.floor(p/width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  eyeLeft=l;eyeRight=r;eyeTop=t;eyeBottom=b;
 }
 if(eyeRight<eyeLeft)throw new Error('Missing face anchor');
 return {bounds:{x:left,y:top,width:right-left+1,height:bottom-top+1},anchor:{x:(eyeLeft+eyeRight)/2,y:(eyeTop+eyeBottom)/2}};
}
export function alignFrames(frames,size) {
 let left=0,right=0,top=0,bottom=0;
 for(const {bounds:b,anchor:a} of frames) {
  left=Math.max(left,a.x-b.x);right=Math.max(right,b.x+b.width-a.x);
  top=Math.max(top,a.y-b.y);bottom=Math.max(bottom,b.y+b.height-a.y);
 }
 const scale=Math.min((size-16)/(2*Math.max(left,right)),(size-16)/(top+bottom));
 const anchorY=8+top*scale;
 return frames.map(({bounds:b,anchor:a})=>({scale,offsetX:size/2-(a.x-b.x)*scale,offsetY:anchorY-(a.y-b.y)*scale}));
}
export function buildManifest(size,count,sequences) {
 const columns=8;
 const animations=Object.fromEntries(Object.entries(sequences).map(([name,sequence])=>[name,{
  canvas:{width:size,height:size},frames:sequence.map(([index,durationMs])=>{
   if(!Number.isInteger(index)||index<0||index>=count||durationMs<80)throw new RangeError('Invalid animation frame');
   return {x:index%columns*size,y:Math.floor(index/columns)*size,width:size,height:size,offsetX:0,offsetY:0,durationMs};
  }),
 }]));
 return {width:columns*size,height:Math.ceil(count/columns)*size,image:'companion/capri-faces-v1.png',animations};
}
