import { expect, it } from "vitest";
import { downsample, encodeWav } from "../src/voice-capture.ts";
it("downsamples to mono 16 kHz and encodes signed PCM WAV", () => {
 const samples = downsample(new Float32Array([1,1,1,-1,-1,-1]), 48000);
 expect([...samples]).toEqual([1,-1]);
 const wav = encodeWav(samples);
 const view = new DataView(wav);
 expect(new TextDecoder().decode(wav.slice(0,4))).toBe("RIFF");
 expect(view.getUint32(24,true)).toBe(16000);
 expect(view.getUint16(22,true)).toBe(1);
 expect(view.getInt16(44,true)).toBe(32767);
 expect(view.getInt16(46,true)).toBe(-32768);
});
it("preserves 16 kHz and rejects invalid rates and over a minute", () => {
 expect([...downsample(new Float32Array([0.5]),16000)]).toEqual([0.5]);
 expect(() => downsample(new Float32Array(1),0)).toThrow();
 expect(encodeWav(new Float32Array(960000)).byteLength).toBe(1_920_044);
 expect(() => encodeWav(new Float32Array(960001))).toThrow();
});
