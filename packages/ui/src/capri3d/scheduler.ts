export interface FrameState { visible: boolean; reduced?: boolean; capture?: boolean; battery?: boolean }
/** A single cancellable timer. No catch-up bursts after a hidden/minimized window returns. */
export class FrameScheduler {
 private timer?: ReturnType<typeof setTimeout>;
 private state: FrameState = { visible: false };
 private last = 0;
 private frame: (delta: number) => void;
 constructor(frame: (delta: number) => void) { this.frame = frame; }
 set(state: FrameState) {
  this.dispose(); this.state=state; this.last=performance.now(); this.schedule();
 }
 private schedule() {
  if (!this.state.visible || this.state.reduced || this.state.capture) return;
  this.timer=setTimeout(()=>{this.timer=undefined;const now=performance.now();this.frame(Math.min(0.1,(now-this.last)/1000));this.last=now;this.schedule();},Math.ceil(1000/(this.state.battery?24:30)));
 }
 dispose() { clearTimeout(this.timer); this.timer=undefined; this.state = { visible: false }; }
}
