import { describe, it, expect, vi } from 'vitest';
import { openDrawer, closeDrawers, stopScroll } from './drawer';

const fakeEl = (name: string) => {
  const classes = new Set<string>();
  return {
    name,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, force: boolean) => (force ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    has: (c: string) => classes.has(c),
    setAttribute: (_k: string, _v: string) => {},
  };
};

describe('openDrawer', () => {
  it('opens only the target drawer and closes the others', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    openDrawer([a, b], b);
    expect(a.has('is-open')).toBe(false);
    expect(b.has('is-open')).toBe(true);
  });

  it('reopening the already-open drawer keeps exactly one open', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    openDrawer([a, b], a);
    expect(a.has('is-open')).toBe(true);
    expect(b.has('is-open')).toBe(false);
  });

  it('also fixes aria-hidden on every drawer', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    const attrs: Record<string, Record<string, string>> = { a: {}, b: {} };
    (a as any).setAttribute = (k: string, v: string) => { attrs.a[k] = v; };
    (b as any).setAttribute = (k: string, v: string) => { attrs.b[k] = v; };
    openDrawer([a, b], b);
    expect(attrs.a['aria-hidden']).toBe('true');
    expect(attrs.b['aria-hidden']).toBe('false');
  });
});

describe('closeDrawers', () => {
  it('closes every drawer and marks them aria-hidden', () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    a.classList.add('is-open');
    b.classList.add('is-open');
    closeDrawers([a, b]);
    expect(a.has('is-open')).toBe(false);
    expect(b.has('is-open')).toBe(false);
  });
});

describe('stopScroll', () => {
  it('jumps to the current position without smooth behaviour', () => {
    const scrollTo = vi.fn();
    stopScroll({ scrollY: 420, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'instant' });
  });
});
