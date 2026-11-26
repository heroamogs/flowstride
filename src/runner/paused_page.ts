import type { Page } from 'playwright';

interface PageGesture {
  action?: 'inspect' | 'click' | 'key' | 'text' | 'scroll';
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  direction?: number;
}

const navigationKeys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

// Coordinates are fractions of the displayed browser viewport, independent of the dashboard size.
export async function interactWithPausedPage(page: Page, gesture: PageGesture): Promise<string | void> {
  if (!page || page.isClosed()) return;
  if (gesture.action === 'text') {
    if (typeof gesture.text === 'string' && gesture.text.length <= 1024) await page.keyboard.insertText(gesture.text);
    return;
  }
  if (gesture.action === 'key') {
    if (gesture.key && navigationKeys.has(gesture.key)) await page.keyboard.press(gesture.key);
    return;
  }
  if (gesture.action !== 'click' && gesture.action !== 'inspect' && gesture.action !== 'scroll') return;
  const { x, y } = gesture;
  if (typeof x !== 'number' || typeof y !== 'number' || !(x >= 0 && x < 1 && y >= 0 && y < 1)) return;
  const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const point = { x: Math.floor(size.width * x), y: Math.floor(size.height * y) };
  if (gesture.action === 'click') {
    await page.mouse.click(point.x, point.y);
  } else if (gesture.action === 'scroll') {
    if (gesture.direction !== 1 && gesture.direction !== -1) return;
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, gesture.direction * Math.round(size.height / 2));
  } else {
    return page.evaluate(({ x, y }) => {
      let el = document.elementFromPoint(x, y);
      for (;;) {
        const inner = el?.shadowRoot?.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) return 'No element at this position.';
      // Report metadata only. Never collect field values, page HTML or arbitrary attributes.
      return [el.localName, ...['role', 'type', 'aria-label', 'placeholder'].flatMap(key => {
        const value = el!.getAttribute(key);
        return value ? [key + '="' + value.slice(0, 100) + '"'] : [];
      })].join(' · ');
    }, point);
  }
}
