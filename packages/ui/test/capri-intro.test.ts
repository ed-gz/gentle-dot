import { describe, expect, it } from 'vitest';
import { IntroDriver, INTRO_BEATS } from '../src/capri2d/intro.ts';

describe('service-start intro driver', () => {
 it('plays every beat in order and ends within ten seconds', () => {
  const driver = new IntroDriver();
  expect(driver.start('service-1', 0)).toBe(true);
  expect(INTRO_BEATS.map(([beat, at]) => driver.sample(at).beat)).toEqual([
   'crackle','left-hand','right-hand','haul','impact-white','impact-ink','split','look','blink','hi','wave','regrab','glance','shatter','crouch','dive','unfold','done',
  ]);
  expect(INTRO_BEATS.at(-1)![1]).toBeLessThanOrEqual(10000);
 });
 it.each(['skip', 'abort'] as const)('%s terminates without replaying the same service', action => {
  const driver = new IntroDriver(); driver.start('one', 0); driver[action]();
  expect(driver.sample(500).beat).toBe('done');
  expect(driver.start('one', 600)).toBe(false);
  expect(driver.start('two', 600)).toBe(true);
 });
 it('reduced motion goes directly to the final pose, never flashing', () => {
  const driver = new IntroDriver(); driver.start('one', 0, true);
  expect(driver.sample(0)).toMatchObject({ beat: 'done', progress: 1 });
 });
 it('blocks startup questions and disconnected starts without queuing a late intro', () => {
  const driver = new IntroDriver();
  expect(driver.start('one', 0, false, true)).toBe(false);
  expect(driver.start('one', 1000)).toBe(false);
 });
 it('clamps time and consumes interrupted episodes', () => {
  const driver = new IntroDriver(); driver.start('one', 10);
  expect(driver.sample(0).beat).toBe('crackle');
  driver.abort(); expect(driver.sample(9999).beat).toBe('done');
 });
});
