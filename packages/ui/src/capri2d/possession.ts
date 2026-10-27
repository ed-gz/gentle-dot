// Window-possession choreography inspired by capri-desktop (MIT); see ./LICENSE.
import type { Rect, RoamFeed } from './roam.ts';
export interface PossessionGuards {perched?:boolean;question?:boolean;approval?:boolean;composer?:boolean;intro?:boolean;reduced?:boolean;stale?:boolean;sleeping?:boolean;paused?:boolean}
export class PossessionDriver {
 private due=0;
 private started:number|undefined;
 rect:Rect|undefined;
 step(feed:RoamFeed,now:number,g:PossessionGuards,roll:number):boolean {
  const r=feed.region,l=feed.laptop;
  const safe=feed.herdr&&g.perched&&!g.question&&!g.approval&&!g.composer&&!g.intro&&!g.reduced&&!g.stale&&!g.sleeping&&!g.paused
   &&[r.x,r.y,r.width,r.height,l.x,l.y,l.width,l.height].every(Number.isFinite)&&r.width>0&&r.height>0
   &&r.x>=l.x&&r.y>=l.y&&r.x+r.width<=l.x+l.width&&r.y+r.height<=l.y+l.height
   &&[feed.x,feed.y,feed.width,feed.height].every(Number.isFinite)
   &&feed.width>0&&feed.height>0&&feed.x>=r.x&&feed.x+feed.width<=r.x+r.width
   &&(Math.abs(feed.y-r.y)<=4||Math.abs(feed.y-(r.y+r.height-feed.height))<=4);
  if(this.started!==undefined){
   if(!safe||now-this.started>=6000||JSON.stringify(r)!==JSON.stringify(this.rect)){this.abort();return false;}
   return true;
  }
  if(!safe||now<this.due)return false;
  // Even a failed probability draw consumes this opportunity: no per-frame lottery.
  this.due=now+600000;
  if(roll>=.18||roll<0||!Number.isFinite(roll))return false;
  this.started=now;this.rect={...r};return true;
 }
 abort(){this.started=undefined;this.rect=undefined;}
}
