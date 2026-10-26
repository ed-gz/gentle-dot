import { render, act, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CapriFaceSprite } from '../src/capri-faces/CapriFaceSprite.tsx';
import { CapriSprite } from '../src/components/CapriCompanion.tsx';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('mobile Capri uses only the face atlas even for full-body action names', async () => {
 const host=document.createElement('div');host.className='mobile-shell';document.body.append(host);
 try {
  const view=render(<CapriSprite pose="working" animated playing={false} />, {container:host});
  await act(async()=>{});
  expect(view.container.querySelector('[data-faces-animation="working"]')).not.toBeNull();
  expect(view.container.querySelector('image')?.getAttribute('href')).toContain('capri-faces-v1.png');
  expect(view.container.innerHTML).not.toContain('capri-motion-');
 } finally {host.remove();}
});
it('authored frames advance only while playing and reset safely for a new action',()=>{
 vi.useFakeTimers();
 const view=render(<CapriFaceSprite action="talking" playing />);
 const sprite=()=>view.container.querySelector('[data-faces-animation]')!;
 expect(sprite()).toHaveAttribute('data-frame','0');
 act(()=>vi.advanceTimersByTime(160));expect(sprite()).toHaveAttribute('data-frame','1');
 view.rerender(<CapriFaceSprite action="talking" playing={false} />);
 act(()=>vi.advanceTimersByTime(5000));expect(sprite()).toHaveAttribute('data-frame','1');
 view.rerender(<CapriFaceSprite action="unknown" playing={false} />);
 expect(sprite()).toHaveAttribute('data-faces-animation','idle');expect(sprite()).toHaveAttribute('data-frame','0');
});
it('desktop retains the existing sprite renderer', () => {
 const view=render(<CapriSprite pose="working" />);
 expect(view.container.querySelector('[data-faces-animation]')).toBeNull();
 expect(view.container.querySelector('image')?.getAttribute('href')).not.toContain('capri-faces');
});
