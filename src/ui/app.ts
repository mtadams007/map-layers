import type { Vec } from '../fit';
import type { Renderer } from '../gl/renderer';
import { ACCEPTED_TYPES, decodeImage, thumbnail } from '../image';
import {
  baseLayer,
  changed,
  fitSummary,
  layerById,
  newPointId,
  onChange,
  selectedLayer,
  state,
  type Layer,
} from '../state';
import { forgetCamera, Pane, resetBaseCamera, type PaneKind } from './panes';

const WORKSPACE_BG: [number, number, number] = [0.953, 0.957, 0.965];

export function startApp(root: HTMLElement, renderer: Renderer) {
  root.innerHTML = `
    <header class="topbar">
      <span class="brand">Map Layers</span>
      <span class="project-name">Untitled map</span>
      <div class="segmented" role="tablist" aria-label="Mode">
        <button data-action="mode" data-value="create">Create</button>
        <button data-action="mode" data-value="view">View</button>
      </div>
      <span class="spacer"></span>
      <span class="muted">Phase 1 preview · nothing is saved yet</span>
    </header>
    <aside class="sidebar" id="sidebar"></aside>
    <main class="workspace" id="workspace"></main>
    <aside class="panel" id="panel"></aside>
    <input type="file" id="file-input" accept="${ACCEPTED_TYPES.join(',')}" multiple hidden>
    <div class="toast" id="toast" hidden></div>
  `;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const sidebar = $('sidebar');
  const workspace = $('workspace');
  const panel = $('panel');
  const fileInput = $('file-input') as HTMLInputElement;
  const toast = $('toast');

  let panes: Pane[] = [];
  let layoutKey = '';
  let drawQueued = false;

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      renderer.resize();
      renderer.clearAll(WORKSPACE_BG);
      for (const p of panes) p.draw(renderer);
    });
  }

  function showError(message: string) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(Number(toast.dataset.timer));
    toast.dataset.timer = String(setTimeout(() => (toast.hidden = true), 6000));
  }

  // ---- Adding layers ----

  let loadingKey = 0;

  async function addFiles(files: File[]) {
    const images = files.filter((f) => ACCEPTED_TYPES.includes(f.type));
    if (images.length < files.length) showError('Only PNG and JPEG images can be added for now.');
    const entries = images.map((f) => ({ key: loadingKey++, name: f.name }));
    state.loading.push(...entries);
    changed();
    // One at a time: a single large map can take hundreds of megabytes while it is decoded.
    for (const [i, file] of images.entries()) {
      try {
        await addLayer(file);
      } catch (err) {
        showError(err instanceof Error ? err.message : `Couldn't add ${file.name}.`);
      }
      state.loading = state.loading.filter((l) => l.key !== entries[i].key);
      changed();
    }
  }

  async function addLayer(file: File) {
    const image = await decodeImage(file);
    const id = crypto.randomUUID();
    try {
      await renderer.upload(id, image.source, image.width, image.height);
      const layer: Layer = {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        width: image.width,
        height: image.height,
        thumbnail: await thumbnail(image),
        points: [],
        pending: null,
        visible: true,
        opacity: 1,
      };
      if (!state.baseId) {
        state.baseId = id;
        state.layers.push(layer);
        resetBaseCamera();
      } else {
        state.layers.unshift(layer);
      }
      if (!state.selectedId || state.selectedId === state.baseId) state.selectedId = id;
    } catch (err) {
      renderer.remove(id);
      const detail = err instanceof Error ? ` ${err.message}` : '';
      throw new Error(`Couldn't add ${file.name} (${image.width} × ${image.height} px).${detail}`);
    } finally {
      image.release();
    }
  }

  function removeLayer(layer: Layer) {
    const isBase = layer.id === state.baseId;
    const others = state.layers.filter((l) => l.id !== layer.id);
    const message = isBase
      ? `Remove the base layer "${layer.name}"? The points on every other layer will be cleared, and the next layer becomes the base.`
      : `Remove "${layer.name}"?`;
    if ((isBase && others.length > 0) || layer.points.length > 0) {
      if (!confirm(message)) return;
    }
    state.layers = others;
    renderer.remove(layer.id);
    forgetCamera(layer.id);
    if (isBase) {
      state.baseId = others.at(-1)?.id ?? null;
      clearAllPoints();
      resetBaseCamera();
    }
    if (state.selectedId === layer.id) state.selectedId = others.find((l) => l.id !== state.baseId)?.id ?? state.baseId;
    changed();
  }

  function makeBase(layer: Layer) {
    const hasPoints = state.layers.some((l) => l.points.length > 0 || l.pending);
    if (hasPoints && !confirm(`Make "${layer.name}" the base? Points on every layer will be cleared, since they are measured against the base.`)) {
      return;
    }
    state.baseId = layer.id;
    clearAllPoints();
    resetBaseCamera();
    if (state.selectedId === layer.id) state.selectedId = state.layers.find((l) => l.id !== layer.id)?.id ?? layer.id;
    changed();
  }

  function clearAllPoints() {
    for (const l of state.layers) {
      l.points = [];
      l.pending = null;
    }
  }

  // ---- Points ----

  function place(side: 'layer' | 'base', p: Vec) {
    const layer = selectedLayer();
    if (!layer || layer.id === state.baseId) return;
    const pending = { ...layer.pending, [side]: p };
    if (pending.layer && pending.base) {
      layer.points.push({ id: newPointId(), layer: pending.layer, base: pending.base });
      layer.pending = null;
    } else {
      layer.pending = pending;
    }
    changed();
  }

  const hooks = {
    requestDraw,
    place,
    pointsDragged: () => {
      renderPanel();
      requestDraw();
    },
    dragEnded: () => changed(),
  };

  // ---- Rendering ----

  function render() {
    root.querySelectorAll<HTMLElement>('[data-action="mode"]').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === state.mode);
    });
    root.dataset.mode = state.mode;
    renderSidebar();
    renderWorkspace();
    renderPanel();
    requestDraw();
  }

  function renderSidebar() {
    if (state.mode === 'view') {
      sidebar.innerHTML = '';
      return;
    }
    const rows = state.layers
      .map((l, i) => {
        const isBase = l.id === state.baseId;
        const selected = l.id === state.selectedId;
        return `
        <li class="layer-row ${selected ? 'selected' : ''}" data-action="select" data-id="${l.id}" draggable="true" data-index="${i}">
          <img class="thumb" src="${l.thumbnail}" alt="">
          <div class="layer-text">
            <div class="layer-name">${esc(l.name)}</div>
            <div class="layer-meta">${isBase ? `${l.width} × ${l.height} px` : layerStatus(l)}</div>
          </div>
          <div class="layer-side">
            <span class="status">${isBase ? '<span class="badge">BASE</span>' : selected ? '<span class="aligning">Aligning</span>' : statusDot(l)}</span>
            <div class="row-actions">
              ${isBase ? '' : `<button class="link" data-action="make-base" data-id="${l.id}">Make base</button>`}
              <button class="icon" data-action="remove" data-id="${l.id}" aria-label="Remove ${esc(l.name)}">×</button>
            </div>
          </div>
        </li>`;
      })
      .join('');
    const loading = state.loading
      .map((l) => `<li class="layer-row loading"><div class="thumb"></div><div class="layer-text"><div class="layer-name">${esc(l.name)}</div><div class="layer-meta">Loading…</div></div></li>`)
      .join('');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <h2>Layers</h2>
        <button class="button" data-action="add">+ Add layer</button>
      </div>
      <ul class="layer-list">${rows}${loading}</ul>
      <p class="sidebar-foot">Drag to reorder. Top of the list draws on top.</p>
    `;
  }

  function layerStatus(l: Layer): string {
    const n = l.points.length;
    if (n < 2) return n === 0 ? 'Not aligned' : '1 point · needs 2';
    const s = fitSummary(l).similarity;
    return n >= 3 && s ? `${n} points · ${s.rms.toFixed(1)} px` : `${n} points`;
  }

  function statusDot(l: Layer): string {
    if (l.points.length < 2) return '<span class="dot empty" title="Not aligned"></span>';
    const warn = fitSummary(l).outliers.some(Boolean);
    return `<span class="dot ${warn ? 'warn' : 'ok'}" title="${warn ? 'Has a point to check' : 'Aligned'}"></span>`;
  }

  function renderWorkspace() {
    const layer = selectedLayer();
    const base = baseLayer();
    const aligning = state.mode === 'create' && layer && base && layer.id !== base.id;
    const key = [
      state.mode,
      state.createView,
      base?.id,
      aligning ? layer!.id : '',
      state.layers.length > 0,
    ].join('|');

    if (key !== layoutKey) {
      layoutKey = key;
      for (const p of panes) p.destroy();
      panes = [];
      workspace.innerHTML = workspaceHtml(Boolean(aligning));
      workspace.querySelectorAll<HTMLElement>('[data-pane]').forEach((el) => {
        panes.push(new Pane(el.dataset.pane as PaneKind, el, hooks));
      });
    }
    // Text that changes without changing the layout.
    const hint = workspace.querySelector('#hint');
    if (hint) hint.textContent = pickHint();
  }

  function workspaceHtml(aligning: boolean): string {
    const base = baseLayer();
    const layer = selectedLayer();
    if (!base) {
      return `
        <div class="empty">
          <h1>Start with your base map</h1>
          <p>The first image you add becomes the base layer. Every other layer is aligned to it.</p>
          <button class="button primary" data-action="add">Add images</button>
          <p class="muted">PNG or JPEG. You can also drop files anywhere on this window.</p>
        </div>`;
    }
    if (state.mode === 'view') {
      return `<div class="panes"><section class="pane bare"><div class="pane-body" data-pane="view"></div></section></div>`;
    }
    if (!aligning) {
      return `
        <div class="toolbar">
          <div class="toolbar-title">${esc(base.name)} <span class="muted">is the base layer</span></div>
          <p class="toolbar-hint">Add another layer, then select it to align it to the base.</p>
        </div>
        <div class="panes">
          ${paneHtml('base', base.name, base)}
        </div>`;
    }
    const side = state.createView === 'side';
    return `
      <div class="toolbar">
        <div class="toolbar-title">${esc(layer!.name)} <span class="muted">aligned to</span><br>${esc(base.name)}</div>
        <div class="segmented">
          <button data-action="view" data-value="side" class="${side ? 'active' : ''}">Side by side</button>
          <button data-action="view" data-value="overlay" class="${side ? '' : 'active'}">Overlay</button>
        </div>
        <p class="toolbar-hint">${
          side
            ? 'Click a feature on the layer, then the same feature on the base. Drag to pan, scroll or pinch to zoom.'
            : 'The layer is drawn over the base. Drag a point to fine-tune; the fit updates as you go.'
        }</p>
      </div>
      <div class="panes ${side ? 'two' : ''}">
        ${side ? paneHtml('layer', layer!.name, layer!) + paneHtml('base', base.name, base) : paneHtml('overlay', `${layer!.name} over ${base.name}`, base)}
      </div>`;
  }

  function paneHtml(kind: PaneKind, title: string, layer: Layer): string {
    const picking = kind === 'layer' || kind === 'base';
    return `
      <section class="pane">
        <header class="pane-head"><span>${esc(title)}</span><span class="mono muted">${layer.width} × ${layer.height} px</span></header>
        <div class="pane-body ${picking ? 'picking' : ''}" data-pane="${kind}">
          ${kind === 'layer' ? '<div class="pane-hint" id="hint"></div>' : ''}
        </div>
      </section>`;
  }

  function pickHint(): string {
    const layer = selectedLayer();
    if (!layer) return '';
    const n = layer.points.length + 1;
    if (layer.pending?.layer) return `Point ${n}: now click the same feature on the base`;
    if (layer.pending?.base) return `Point ${n}: now click the same feature on the layer`;
    return `Point ${n}: click on the layer`;
  }

  function renderPanel() {
    panel.innerHTML = state.mode === 'view' ? viewPanelHtml() : fitPanelHtml();
  }

  function fitPanelHtml(): string {
    const layer = selectedLayer();
    if (!layer) return '';
    if (layer.id === state.baseId) {
      return `<h2>Fit</h2><p class="muted">This is the base layer. Other layers are aligned to it, so it has no points of its own.</p>`;
    }
    const n = layer.points.length;
    const { similarity, affine, outliers } = fitSummary(layer);

    let headline: string;
    if (n < 2) {
      headline = `<p class="fit-empty">Add ${2 - n} more point${n === 1 ? '' : 's'} to place this layer.</p>`;
    } else if (n === 2) {
      headline = `<p class="fit-empty">Two points always fit exactly. Add a third to measure the error.</p>`;
    } else {
      headline = `
        <div class="fit-error"><span class="mono big">${similarity!.rms.toFixed(1)} px</span> average error</div>
        <p class="muted">${affineNote(similarity!.rms, affine?.rms ?? null, n)}</p>`;
    }

    const rows = layer.points
      .map((_, i) => {
        const err = n >= 3 && similarity ? `${similarity.errors[i].toFixed(1)} px` : '—';
        const bad = outliers[i];
        return `
          <li class="point-row ${bad ? 'outlier' : ''}">
            <span class="num">${i + 1}</span>
            <span class="point-label">${bad ? 'Check this point' : ''}</span>
            <span class="mono">${err}</span>
            <button class="icon" data-action="delete-point" data-index="${i}" aria-label="Delete point ${i + 1}">×</button>
          </li>`;
      })
      .join('');
    const pendingRow = layer.pending
      ? `<li class="point-row pending">
           <span class="num">${n + 1}</span>
           <span class="point-label">Waiting for the ${layer.pending.layer ? 'base' : 'layer'}</span>
           <span></span>
           <button class="icon" data-action="cancel-pending" aria-label="Cancel point ${n + 1}">×</button>
         </li>`
      : '';

    const overlay =
      state.createView === 'overlay'
        ? `<div class="divider"></div>
           <h2>Overlay</h2>
           ${sliderHtml('overlay-opacity', 'Layer opacity', state.overlayOpacity)}`
        : '';

    return `
      <h2>Fit</h2>
      <div class="segmented wide">
        <button class="active">Similarity</button>
        <button disabled title="Arrives in phase 2">Affine (stretch)</button>
      </div>
      ${headline}
      ${n || layer.pending ? `<div class="table-head"><span>Point</span><span>Error</span></div><ul class="points">${rows}${pendingRow}</ul>` : ''}
      <p class="muted small">Drag any point to move it. The fit updates as you go. Esc cancels a half-placed point.</p>
      ${overlay}`;
  }

  function affineNote(sim: number, aff: number | null, n: number): string {
    if (aff === null) return '';
    if (n === 3) return 'Affine fits 3 points exactly, so add a fourth point to compare it.';
    const worth = aff < sim * 0.6 && sim - aff > 1;
    return `Affine would give <span class="mono">${aff.toFixed(1)} px</span>. ${
      worth ? 'The layer may be stretched.' : 'Not worth the stretch.'
    }`;
  }

  function viewPanelHtml(): string {
    const rows = state.layers
      .map((l) => {
        const aligned = l.id === state.baseId || l.points.length >= 2;
        if (!aligned) {
          return `<li class="view-row off"><span class="eye-space"></span><span class="view-name">${esc(l.name)}</span><span class="muted">Not aligned</span></li>`;
        }
        return `
          <li class="view-row ${l.visible ? '' : 'off'}">
            <button class="eye" data-action="toggle" data-id="${l.id}" aria-label="${l.visible ? 'Hide' : 'Show'} ${esc(l.name)}" aria-pressed="${l.visible}">${l.visible ? EYE : EYE_OFF}</button>
            <span class="view-name">${esc(l.name)}</span>
            ${l.visible ? sliderHtml('layer-opacity', '', l.opacity, l.id) : '<span class="muted">Hidden</span>'}
          </li>`;
      })
      .join('');
    return `<h2>Layers</h2><ul class="view-list">${rows}</ul>
      <p class="muted small">Drag to pan, scroll or pinch to zoom, double-click to zoom in.</p>`;
  }

  // ---- Events ----

  root.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const id = target.dataset.id ?? null;
    switch (target.dataset.action) {
      case 'mode':
        state.mode = target.dataset.value as typeof state.mode;
        changed();
        break;
      case 'view':
        state.createView = target.dataset.value as typeof state.createView;
        changed();
        break;
      case 'add':
        fileInput.click();
        break;
      case 'select':
        if (state.selectedId !== id) {
          state.selectedId = id;
          changed();
        }
        break;
      case 'make-base':
        e.stopPropagation();
        makeBase(layerById(id)!);
        break;
      case 'remove':
        e.stopPropagation();
        removeLayer(layerById(id)!);
        break;
      case 'delete-point': {
        const layer = selectedLayer();
        layer?.points.splice(Number(target.dataset.index), 1);
        changed();
        break;
      }
      case 'cancel-pending':
        cancelPending();
        break;
      case 'toggle': {
        const layer = layerById(id)!;
        layer.visible = !layer.visible;
        changed();
        break;
      }
    }
  });

  root.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const value = Number(input.value) / 100;
    if (input.dataset.slider === 'overlay-opacity') state.overlayOpacity = value;
    else if (input.dataset.slider === 'layer-opacity') layerById(input.dataset.id ?? null)!.opacity = value;
    else return;
    // Update the readout in place; re-rendering would interrupt the drag.
    const out = input.parentElement?.querySelector('output');
    if (out) out.textContent = `${Math.round(value * 100)}%`;
    requestDraw();
  });

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void addFiles(files);
  });

  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    if (state.mode === 'view') state.mode = 'create';
    void addFiles([...e.dataTransfer.files]);
  });

  // Reordering the layer list.
  let dragIndex: number | null = null;
  sidebar.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.layer-row');
    if (!row?.dataset.index) return;
    dragIndex = Number(row.dataset.index);
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', row.dataset.id ?? '');
  });
  sidebar.addEventListener('dragover', (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    e.stopPropagation();
    sidebar.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const row = (e.target as HTMLElement).closest<HTMLElement>('.layer-row');
    if (row?.dataset.index) {
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    }
  });
  sidebar.addEventListener('drop', (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    e.stopPropagation();
    const row = (e.target as HTMLElement).closest<HTMLElement>('.layer-row');
    if (row?.dataset.index) {
      const r = row.getBoundingClientRect();
      let to = Number(row.dataset.index) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      if (to > dragIndex) to--;
      const [moved] = state.layers.splice(dragIndex, 1);
      state.layers.splice(to, 0, moved);
    }
    dragIndex = null;
    changed();
  });
  sidebar.addEventListener('dragend', () => {
    dragIndex = null;
    renderSidebar();
  });

  function cancelPending() {
    const layer = selectedLayer();
    if (layer?.pending) {
      layer.pending = null;
      changed();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelPending();
  });

  new ResizeObserver(requestDraw).observe(workspace);
  onChange(render);
  render();
}

function sliderHtml(name: string, label: string, value: number, id = ''): string {
  const pct = Math.round(value * 100);
  return `
    <label class="slider">
      ${label ? `<span>${label}</span>` : ''}
      <input type="range" min="0" max="100" value="${pct}" data-slider="${name}" data-id="${id}" aria-label="${label || 'Opacity'}">
      <output class="mono">${pct}%</output>
    </label>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const EYE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="2"/></svg>`;
