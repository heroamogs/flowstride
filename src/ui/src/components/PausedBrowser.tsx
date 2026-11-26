import { useState } from 'react';
import { sendToRunner } from '../socket';
import { useFlowStore } from '../store';

export function PausedBrowser({ id, frame }: { id: string; frame: string }) {
  const [picking, setPicking] = useState(false);
  const result = useFlowStore(state => state.inspectionResult);
  const send = (action: string, data: Record<string, unknown>) => sendToRunner('INSPECT_PAUSED', { pauseId: id, action, ...data });
  const point = (img: HTMLImageElement, x: number, y: number) => {
    const box = img.getBoundingClientRect();
    return { x: (x - box.left) / box.width, y: (y - box.top) / box.height };
  };
  return <section aria-label="Live paused browser" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#151922', color: '#fff' }}>
    <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="button" aria-pressed={picking} onClick={() => setPicking(!picking)}>{picking ? 'Finish inspecting' : 'Inspect element'}</button>
      <span role="status">{picking && result?.id === id ? result.description : picking ? 'Select an element on the page.' : 'Click the page to interact. Type into a focused field.'}</span>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <img src={'data:image/jpeg;base64,' + frame} alt="Interactive paused page" tabIndex={0}
        style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', minHeight: 0, minWidth: 0, cursor: picking ? 'crosshair' : 'default' }}
        onClick={event => {
          event.currentTarget.focus();
          send(picking ? 'inspect' : 'click', point(event.currentTarget, event.clientX, event.clientY));
        }}
        onWheel={event => { if (!picking && event.deltaY) send('scroll', { ...point(event.currentTarget, event.clientX, event.clientY), direction: Math.sign(event.deltaY) }); }}
        onKeyDown={event => {
          if (picking || event.metaKey || event.ctrlKey || event.altKey || event.key === 'Tab') return;
          if (event.key.length === 1) send('text', { text: event.key });
          else send('key', { key: event.key });
          event.preventDefault();
        }}
        onPaste={event => { if (!picking) { event.preventDefault(); send('text', { text: event.clipboardData.getData('text').slice(0, 1024) }); } }}
      />
    </div>
  </section>;
}
