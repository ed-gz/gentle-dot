import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionControlReview } from '../src/session-control-review.tsx';
import type { DesktopConnection } from '../src/desktop-tools.ts';
export function mountReviewHarness(connection:DesktopConnection) {
 const container=document.createElement('div');container.id='review-harness';document.body.appendChild(container);
 const root=createRoot(container);let current:DesktopConnection|undefined=connection;const getCurrent=()=>current;
 const render=()=>root.render(createElement(SessionControlReview,{connection:current!,current:getCurrent,active:true,busy:false}));render();
 return {setConnection(next:DesktopConnection){current=next;render();},destroy(){current=undefined;root.unmount();container.remove();}};
}
