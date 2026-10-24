/** PC recognizer contract: mono 16 kHz signed 16-bit PCM, at most one minute. */
export function downsample(input: Float32Array, rate: number): Float32Array {
 if (!Number.isFinite(rate) || rate < 16000) throw new Error("Unsupported microphone rate.");
 const ratio = rate / 16000;
 const out = new Float32Array(Math.floor(input.length / ratio));
 for (let i=0; i<out.length; i++) {
  const start = Math.floor(i*ratio), end = Math.floor((i+1)*ratio);
  let sum=0;
  for (let j=start;j<end;j++) sum += input[j] ?? 0;
  out[i] = sum / (end-start);
 }
 return out;
}
export function encodeWav(samples: Float32Array): ArrayBuffer {
 if (!samples.length || samples.length > 960000) throw new Error("Recording must be under one minute.");
 const buffer = new ArrayBuffer(44+samples.length*2), view = new DataView(buffer);
 const text = (offset:number, s:string) => { for(let i=0;i<s.length;i++) view.setUint8(offset+i,s.charCodeAt(i)); };
 text(0,"RIFF"); view.setUint32(4,buffer.byteLength-8,true); text(8,"WAVEfmt ");
 view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
 view.setUint32(24,16000,true); view.setUint32(28,32000,true);
 view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,"data"); view.setUint32(40,samples.length*2,true);
 samples.forEach((s,i) => { const value = Math.max(-1,Math.min(1,Number.isFinite(s)?s:0)); view.setInt16(44+i*2,Math.round(value*(value<0?32768:32767)),true); });
 return buffer;
}
export interface PcmCapture { stop(): Blob; cancel(): void }
/** ScriptProcessor is the WebView-compatible fallback; it needs no worklet URL or bundled asset. */
export async function capturePcm(onLevel: (value:number)=>void): Promise<PcmCapture> {
 const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:16000,echoCancellation:true}});
 let context: AudioContext | undefined;
 try {
  context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096,1,1);
  const mute = context.createGain(); mute.gain.value = 0;
  const chunks: Float32Array[] = []; let count=0, closed=false;
  const rate=context.sampleRate, limit=rate*60;
  processor.onaudioprocess = event => {
   if(closed || count>=limit) return;
   const input=event.inputBuffer.getChannelData(0);
   const chunk=input.slice(0,Math.min(input.length,limit-count));
   chunks.push(chunk); count+=chunk.length;
   let sum=0; for(const sample of chunk) sum+=sample*sample;
   onLevel(Math.min(1,Math.sqrt(sum/(chunk.length||1))*3));
  };
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  await context.resume();
  const close = () => {
   if(closed) return; closed=true; processor.onaudioprocess=null;
   source.disconnect(); processor.disconnect(); mute.disconnect();
   for(const track of stream.getTracks()) track.stop();
   void context?.close();
  };
  return {
   cancel: () => { close(); chunks.length=0; },
   stop: () => {
    close(); const all=new Float32Array(count); let offset=0;
    for(const chunk of chunks) { all.set(chunk,offset); offset+=chunk.length; }
    chunks.length=0;
    return new Blob([encodeWav(downsample(all,rate))],{type:"audio/wav"});
   },
  };
 } catch(error) {
  for(const track of stream.getTracks()) track.stop();
  void context?.close(); throw error;
 }
}
