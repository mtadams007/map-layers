import './styles.css';
import { preventPageZoom } from './gestures';
import { PHONE_TILE, Renderer } from './gl/renderer';
import { usesPhoneCopies } from './image';
import { startApp } from './ui/app';

const canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const root = document.querySelector<HTMLElement>('#app')!;

preventPageZoom();

try {
  const renderer = new Renderer(canvas);
  if (usesPhoneCopies()) renderer.tileLimit = PHONE_TILE;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    root.innerHTML = `<div class="fatal"><h1>The graphics context was lost</h1><p>This can happen when the browser runs short of graphics memory. Reload the page to start again.</p></div>`;
  });
  startApp(root, renderer);
} catch (err) {
  root.innerHTML = `<div class="fatal"><h1>Map Layers can't start</h1><p></p></div>`;
  root.querySelector('.fatal p')!.textContent = err instanceof Error ? err.message : String(err);
}
