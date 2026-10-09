import type { Vec } from '../fit';
import type { Renderer } from '../gl/renderer';
import { ACCEPTED_TYPES, decodeImage, thumbnail } from '../image';
import { ProjectError, type Project } from '../project';
import {
  baseLayer,
  canUseAffine,
  changed,
  edited,
  fitSummary,
  layerById,
  newPointId,
  onChange,
  selectedLayer,
  state,
  toProject,
  transformOf,
  type Layer,
} from '../state';
import { deleteProject, getImages, getProject, listProjects, renameProject, saveProject, type StoredProject } from '../storage';
import { composeThumbnail } from '../thumbnail';
import { buildZip, readZip } from '../zip';
import { newId } from '../id';
import { esc } from './html';
import { libraryHtml } from './library';
import { forgetCamera, Pane, resetBaseCamera, type PaneKind } from './panes';

const WORKSPACE_BG: [number, number, number] = [0.953, 0.957, 0.965];
const UNTITLED = 'Untitled map';

export function startApp(root: HTMLElement, renderer: Renderer) {
  root.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <aside class="sidebar" id="sidebar"></aside>
    <main class="workspace" id="workspace"></main>
    <aside class="panel" id="panel"></aside>
    <input type="file" id="file-input" accept="${ACCEPTED_TYPES.join(',')}" multiple hidden>
    <input type="file" id="zip-input" accept=".zip,application/zip" hidden>
    <div class="busy" id="busy" hidden><div class="busy-box" id="busy-text"></div></div>
    <div class="toast" id="toast" hidden></div>
  `;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const topbar = $('topbar');
  const sidebar = $('sidebar');
  const workspace = $('workspace');
  const panel = $('panel');
  const fileInput = $('file-input') as HTMLInputElement;
  const zipInput = $('zip-input') as HTMLInputElement;
  const busy = $('busy');
  const busyText = $('busy-text');
  const toast = $('toast');

  let panes: Pane[] = [];
  let layoutKey = '';
  let topbarKey = '';
  let drawQueued = false;
  /** Library contents; null while loading. */
  let library: StoredProject[] | null = null;
  let openMenu: string | null = null;
  /** Layer whose name is being edited in the layer list. */
  let renamingLayer: string | null = null;
  let saving = false;

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
    showToast(message);
  }

  function showToast(message: string) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(Number(toast.dataset.timer));
    toast.dataset.timer = String(setTimeout(() => (toast.hidden = true), 7000));
  }

  function setBusy(message: string | null) {
    busy.hidden = message === null;
    busyText.textContent = message ?? '';
  }

  function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  // ---- Library ----

  async function refreshLibrary() {
    try {
      library = await listProjects();
    } catch (err) {
      library = [];
      showError(errorMessage(err, "Your maps couldn't be loaded."));
    }
    if (state.screen === 'library') changed();
  }

  function newMap() {
    resetEditor();
    state.map = { id: newId(), name: UNTITLED, created: new Date().toISOString() };
    state.screen = 'editor';
    state.mode = 'create';
    changed();
  }

  async function openMap(id: string) {
    const stored = await getProject(id).catch(() => undefined);
    if (!stored) {
      showError("That map couldn't be found. It may have been deleted.");
      return refreshLibrary();
    }
    const images = await getImages(stored.project);
    await loadIntoEditor(stored.project, images, true);
  }

  /**
   * Decode and upload every layer of a project and show it in the editor. Layers are loaded one at a
   * time to keep memory down. If anything fails, the editor is cleared and the library shown again.
   */
  async function loadIntoEditor(project: Project, images: Map<string, Blob>, stored: boolean) {
    resetEditor();
    state.map = { id: project.id, name: project.name, created: project.created };
    const warnings: string[] = [];
    try {
      for (const [i, pl] of project.layers.entries()) {
        setBusy(`Opening ${project.name}: layer ${i + 1} of ${project.layers.length}`);
        const blob = images.get(pl.id);
        if (!blob) throw new ProjectError(`The image for "${pl.name}" is missing.`);
        const image = await decodeImage(blob, pl.name);
        try {
          await renderer.upload(pl.id, image.source, image.width, image.height);
          if (image.width !== pl.width || image.height !== pl.height) {
            warnings.push(`"${pl.name}" is ${image.width} × ${image.height} px but was ${pl.width} × ${pl.height} px when aligned, so its points may no longer match.`);
          }
          state.layers.push({
            id: pl.id,
            name: pl.name,
            width: image.width,
            height: image.height,
            file: blob,
            stored,
            thumbnail: await thumbnail(image),
            points: pl.alignment.points.map((p) => ({ id: newPointId(), layer: p.layer, base: p.base })),
            pending: null,
            fitMode: pl.alignment.mode,
            visible: pl.visible,
            opacity: pl.appearance.opacity,
          });
        } finally {
          image.release();
        }
      }
    } catch (err) {
      setBusy(null);
      closeEditor();
      showError(errorMessage(err, `${project.name} couldn't be opened.`));
      return;
    }
    setBusy(null);
    state.baseId = project.baseLayerId;
    state.selectedId = state.layers.find((l) => l.id !== state.baseId)?.id ?? state.baseId;
    state.screen = 'editor';
    state.mode = 'create';
    state.dirty = !stored;
    resetBaseCamera();
    changed();
    if (warnings.length) showToast(warnings.join(' '));
  }

  /** Release the open map's textures and clear the editor state. */
  function resetEditor() {
    for (const l of state.layers) {
      renderer.remove(l.id);
      forgetCamera(l.id);
    }
    state.layers = [];
    state.loading = [];
    state.baseId = null;
    state.selectedId = null;
    state.map = null;
    state.dirty = false;
    renamingLayer = null;
  }

  function closeEditor() {
    resetEditor();
    state.screen = 'library';
    openMenu = null;
    library = null;
    changed();
    void refreshLibrary();
  }

  function leaveEditor() {
    if (state.dirty && !confirm('This map has unsaved changes. Leave without saving?')) return;
    closeEditor();
  }

  async function importZip(file: File) {
    setBusy(`Reading ${file.name}…`);
    try {
      const { project, images, thumbnail: thumb } = await readZip(file);
      const existing = await getProject(project.id);
      if (existing && !confirm(`"${existing.project.name}" is already in your library. Replace it with the imported copy?`)) {
        return;
      }
      setBusy(`Saving ${project.name}…`);
      await saveProject(project, images, thumb);
      showToast(`Imported ${project.name}.`);
    } catch (err) {
      showError(errorMessage(err, `${file.name} couldn't be imported.`));
    } finally {
      setBusy(null);
      await refreshLibrary();
    }
  }

  async function exportStored(id: string) {
    setBusy('Preparing the .zip…');
    try {
      const stored = await getProject(id);
      if (!stored) throw new Error("That map couldn't be found.");
      const images = await getImages(stored.project);
      download(await buildZip(stored.project, images, stored.thumbnail), stored.project.name);
    } catch (err) {
      showError(errorMessage(err, "The map couldn't be exported."));
    } finally {
      setBusy(null);
    }
  }

  async function renameStored(id: string) {
    const current = library?.find((m) => m.id === id)?.project.name ?? '';
    const name = prompt('Rename map', current)?.trim();
    if (!name || name === current) return;
    await renameProject(id, name).catch((err) => showError(errorMessage(err, "The map couldn't be renamed.")));
    await refreshLibrary();
  }

  async function deleteStored(id: string) {
    const name = library?.find((m) => m.id === id)?.project.name ?? 'this map';
    if (!confirm(`Delete "${name}" from this device? This can't be undone. Exported .zip files are not affected.`)) return;
    await deleteProject(id).catch((err) => showError(errorMessage(err, "The map couldn't be deleted.")));
    await refreshLibrary();
  }

  // ---- Saving and exporting the open map ----

  async function mapThumbnail(): Promise<Blob | null> {
    const base = baseLayer();
    if (!base) return null;
    const layers = [...state.layers]
      .reverse()
      .map((l) => ({ l, t: transformOf(l) }))
      .filter(({ l, t }) => t && l.visible)
      .map(({ l, t }) => ({ thumbnail: l.thumbnail, width: l.width, height: l.height, transform: t!, opacity: l.opacity }));
    return composeThumbnail(base, layers).catch(() => null);
  }

  async function save() {
    if (!state.map || saving) return;
    saving = true;
    renderTopbar();
    try {
      const project = toProject(new Date().toISOString());
      const newImages = new Map(state.layers.filter((l) => !l.stored).map((l) => [l.id, l.file]));
      await saveProject(project, newImages, await mapThumbnail());
      for (const l of state.layers) l.stored = true;
      state.dirty = false;
    } catch (err) {
      showError(errorMessage(err, "The map couldn't be saved."));
    } finally {
      saving = false;
      changed();
    }
  }

  async function exportOpen() {
    if (!state.map) return;
    setBusy('Preparing the .zip…');
    try {
      const project = toProject(new Date().toISOString());
      const images = new Map(state.layers.map((l) => [l.id, l.file]));
      download(await buildZip(project, images, await mapThumbnail()), project.name);
    } catch (err) {
      showError(errorMessage(err, "The map couldn't be exported."));
    } finally {
      setBusy(null);
    }
  }

  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'map'}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
        showError(errorMessage(err, `Couldn't add ${file.name}.`));
      }
      state.loading = state.loading.filter((l) => l.key !== entries[i].key);
      changed();
    }
  }

  async function addLayer(file: File) {
    const image = await decodeImage(file, file.name);
    const id = newId();
    try {
      await renderer.upload(id, image.source, image.width, image.height);
      const layer: Layer = {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        width: image.width,
        height: image.height,
        file,
        stored: false,
        thumbnail: await thumbnail(image),
        points: [],
        pending: null,
        fitMode: 'similarity',
        visible: true,
        opacity: 1,
      };
      if (!state.baseId) {
        state.baseId = id;
        state.layers.push(layer);
        if (state.map && state.map.name === UNTITLED) state.map.name = layer.name;
        resetBaseCamera();
      } else {
        state.layers.unshift(layer);
      }
      if (!state.selectedId || state.selectedId === state.baseId) state.selectedId = id;
      state.dirty = true;
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
    edited();
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
    edited();
  }

  function clearAllPoints() {
    for (const l of state.layers) {
      l.points = [];
      l.pending = null;
    }
  }

  function renameLayer(layer: Layer, name: string) {
    renamingLayer = null;
    const trimmed = name.trim();
    if (trimmed && trimmed !== layer.name) {
      layer.name = trimmed;
      edited();
    } else {
      changed();
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
      edited();
    } else {
      layer.pending = pending;
      changed();
    }
  }

  const hooks = {
    requestDraw,
    place,
    pointsDragged: () => {
      state.dirty = true;
      renderPanel();
      renderTopbar();
      requestDraw();
    },
    dragEnded: () => edited(),
  };

  // ---- Rendering ----

  function render() {
    root.dataset.screen = state.screen;
    root.dataset.mode = state.mode;
    renderTopbar();
    if (state.screen === 'library') {
      for (const p of panes) p.destroy();
      panes = [];
      layoutKey = '';
      sidebar.innerHTML = '';
      panel.innerHTML = '';
      workspace.innerHTML = libraryHtml(library, openMenu);
      requestDraw();
      return;
    }
    renderSidebar();
    renderWorkspace();
    renderPanel();
    requestDraw();
  }

  function renderTopbar() {
    if (state.screen === 'library') {
      if (topbarKey !== 'library') {
        topbarKey = 'library';
        topbar.innerHTML = `<span class="project-name">Map Layers</span>`;
      }
      return;
    }
    if (topbarKey !== 'editor') {
      topbarKey = 'editor';
      topbar.innerHTML = `
        <button class="link back" data-action="library">‹ Library</button>
        <input class="name-input" id="map-name" aria-label="Map name" spellcheck="false">
        <div class="segmented" role="tablist" aria-label="Mode">
          <button data-action="mode" data-value="create">Create</button>
          <button data-action="mode" data-value="view">View</button>
        </div>
        <span class="spacer"></span>
        <span class="save-status" id="save-status"></span>
        <button class="button" data-action="export-open">Export .zip</button>
        <button class="button primary" data-action="save" id="save-button">Save</button>`;
    }
    const nameInput = topbar.querySelector<HTMLInputElement>('#map-name')!;
    if (document.activeElement !== nameInput) nameInput.value = state.map?.name ?? '';
    topbar.querySelectorAll<HTMLElement>('[data-action="mode"]').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === state.mode);
    });
    const status = topbar.querySelector('#save-status')!;
    const button = topbar.querySelector<HTMLButtonElement>('#save-button')!;
    const empty = state.layers.length === 0;
    status.textContent = saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : empty ? '' : 'Saved on this device';
    status.classList.toggle('unsaved', state.dirty && !saving);
    button.disabled = saving || empty || !state.dirty;
    topbar.querySelector<HTMLButtonElement>('[data-action="export-open"]')!.disabled = empty;
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
        const name =
          renamingLayer === l.id
            ? `<input class="layer-name-input" data-rename="${l.id}" value="${esc(l.name)}" aria-label="Layer name">`
            : `<div class="layer-name" title="Double-click to rename">${esc(l.name)}</div>`;
        return `
        <li class="layer-row ${selected ? 'selected' : ''}" data-action="select" data-id="${l.id}" draggable="${renamingLayer !== l.id}" data-index="${i}">
          <img class="thumb" src="${l.thumbnail}" alt="">
          <div class="layer-text">
            ${name}
            <div class="layer-meta">${isBase ? `${l.width} × ${l.height} px` : layerStatus(l)}</div>
          </div>
          <div class="layer-side">
            <span class="status">${isBase ? '<span class="badge">BASE</span>' : selected ? '<span class="aligning">Aligning</span>' : statusDot(l)}</span>
            <div class="row-actions">
              <button class="link" data-action="rename-layer" data-id="${l.id}">Rename</button>
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
      <p class="sidebar-foot">Drag to reorder. Top of the list draws on top. Double-click a name to rename it.</p>
    `;
    const input = sidebar.querySelector<HTMLInputElement>('.layer-name-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function layerStatus(l: Layer): string {
    const n = l.points.length;
    if (n < 2) return n === 0 ? 'Not aligned' : '1 point · needs 2';
    const s = fitSummary(l).active;
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
      state.screen,
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
    workspace.querySelectorAll<HTMLElement>('[data-layer-title]').forEach((el) => {
      el.textContent = layerById(el.dataset.layerTitle!)?.name ?? '';
    });
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
          <div class="toolbar-title"><span data-layer-title="${base.id}"></span> <span class="muted">is the base layer</span></div>
          <p class="toolbar-hint">Add another layer, then select it to align it to the base.</p>
        </div>
        <div class="panes">
          ${paneHtml('base', base)}
        </div>`;
    }
    const side = state.createView === 'side';
    return `
      <div class="toolbar">
        <div class="toolbar-title"><span data-layer-title="${layer!.id}"></span> <span class="muted">aligned to</span><br><span data-layer-title="${base.id}"></span></div>
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
        ${side ? paneHtml('layer', layer!) + paneHtml('base', base) : paneHtml('overlay', base, layer!)}
      </div>`;
  }

  function paneHtml(kind: PaneKind, layer: Layer, over?: Layer): string {
    const picking = kind === 'layer' || kind === 'base';
    const title = over
      ? `<span><span data-layer-title="${over.id}"></span> over <span data-layer-title="${layer.id}"></span></span>`
      : `<span data-layer-title="${layer.id}"></span>`;
    return `
      <section class="pane">
        <header class="pane-head">${title}<span class="mono muted">${layer.width} × ${layer.height} px</span></header>
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
    const look = `
      <div class="divider"></div>
      <h2>Look</h2>
      ${sliderHtml('layer-opacity', 'Opacity', layer.opacity, layer.id)}
      <p class="muted small">Saved with the map. Viewers start from this.</p>`;
    if (layer.id === state.baseId) {
      return `<h2>Fit</h2><p class="muted">This is the base layer. Other layers are aligned to it, so it has no points of its own.</p>${look}`;
    }
    const n = layer.points.length;
    const { similarity, affine, active, outliers } = fitSummary(layer);
    const affineOn = layer.fitMode === 'affine' && canUseAffine(layer);

    let headline: string;
    if (n < 2) {
      headline = `<p class="fit-empty">Add ${2 - n} more point${n === 1 ? '' : 's'} to place this layer.</p>`;
    } else if (n === 2) {
      headline = `<p class="fit-empty">Two points always fit exactly. Add a third to measure the error.</p>`;
    } else {
      headline = `
        <div class="fit-error"><span class="mono big">${active!.rms.toFixed(1)} px</span> average error</div>
        <p class="muted">${compareNote(affineOn, similarity?.rms ?? null, affine?.rms ?? null, n)}</p>`;
    }

    const rows = layer.points
      .map((_, i) => {
        const err = n >= 3 && active ? `${active.errors[i].toFixed(1)} px` : '—';
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
           ${sliderHtml('overlay-opacity', 'Layer opacity while aligning', state.overlayOpacity)}`
        : '';

    const affineTitle = canUseAffine(layer) ? 'Allows separate x/y scale and skew' : 'Needs at least 3 points';
    return `
      <h2>Fit</h2>
      <div class="segmented wide">
        <button data-action="fit-mode" data-value="similarity" class="${affineOn ? '' : 'active'}">Similarity</button>
        <button data-action="fit-mode" data-value="affine" class="${affineOn ? 'active' : ''}" ${canUseAffine(layer) ? '' : 'disabled'} title="${affineTitle}">Affine (stretch)</button>
      </div>
      ${layer.fitMode === 'affine' && !affineOn ? '<p class="muted small">Affine needs 3 points; using similarity until then.</p>' : ''}
      ${headline}
      ${n || layer.pending ? `<div class="table-head"><span>Point</span><span>Error</span></div><ul class="points">${rows}${pendingRow}</ul>` : ''}
      <p class="muted small">Drag any point to move it. The fit updates as you go. Esc cancels a half-placed point.</p>
      ${look}
      ${overlay}`;
  }

  /** Compare the fit in use with the other mode, so it's clear whether affine helps. */
  function compareNote(affineOn: boolean, sim: number | null, aff: number | null, n: number): string {
    if (sim === null || aff === null) return '';
    if (n === 3) {
      return affineOn
        ? 'Affine fits 3 points exactly, so the error only means something from 4 points.'
        : 'Affine fits 3 points exactly, so add a fourth point to compare it.';
    }
    if (affineOn) {
      return `Similarity would give <span class="mono">${sim.toFixed(1)} px</span>.`;
    }
    const worth = aff < sim * 0.6 && sim - aff > 1;
    return `Affine would give <span class="mono">${aff.toFixed(1)} px</span>. ${
      worth ? 'The layer may be stretched; try Affine.' : 'Not worth the stretch.'
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
      <p class="muted small">Drag to pan, scroll or pinch to zoom, double-click to zoom in. Opacity and visibility are saved with the map.</p>`;
  }

  // ---- Events ----

  root.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) {
      if (openMenu) {
        openMenu = null;
        changed();
      }
      return;
    }
    const id = target.dataset.id ?? null;
    switch (target.dataset.action) {
      // Library
      case 'new-map':
        newMap();
        break;
      case 'import':
        zipInput.click();
        break;
      case 'open':
        if (openMenu) {
          openMenu = null;
          changed();
        } else if (id) {
          void openMap(id);
        }
        break;
      case 'map-menu':
        e.stopPropagation();
        openMenu = openMenu === id ? null : id;
        changed();
        break;
      case 'rename-map':
        e.stopPropagation();
        openMenu = null;
        void renameStored(id!);
        break;
      case 'export-map':
        e.stopPropagation();
        openMenu = null;
        changed();
        void exportStored(id!);
        break;
      case 'delete-map':
        e.stopPropagation();
        openMenu = null;
        void deleteStored(id!);
        break;
      // Editor
      case 'library':
        leaveEditor();
        break;
      case 'save':
        void save();
        break;
      case 'export-open':
        void exportOpen();
        break;
      case 'mode':
        state.mode = target.dataset.value as typeof state.mode;
        changed();
        break;
      case 'view':
        state.createView = target.dataset.value as typeof state.createView;
        changed();
        break;
      case 'fit-mode': {
        const layer = selectedLayer();
        if (layer && layer.fitMode !== target.dataset.value) {
          layer.fitMode = target.dataset.value as Layer['fitMode'];
          edited();
        }
        break;
      }
      case 'add':
        fileInput.click();
        break;
      case 'select':
        if (state.selectedId !== id && renamingLayer !== id) {
          state.selectedId = id;
          changed();
        }
        break;
      case 'rename-layer':
        e.stopPropagation();
        renamingLayer = id;
        changed();
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
        edited();
        break;
      }
      case 'cancel-pending':
        cancelPending();
        break;
      case 'toggle': {
        const layer = layerById(id)!;
        layer.visible = !layer.visible;
        edited();
        break;
      }
    }
  });

  sidebar.addEventListener('dblclick', (e) => {
    const name = (e.target as HTMLElement).closest('.layer-name');
    const row = name?.closest<HTMLElement>('.layer-row');
    if (row?.dataset.id) {
      renamingLayer = row.dataset.id;
      changed();
    }
  });

  sidebar.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.rename) return;
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      input.value = layerById(input.dataset.rename)?.name ?? '';
      input.blur();
    }
  });

  sidebar.addEventListener('focusout', (e) => {
    const input = e.target as HTMLInputElement;
    const layer = input.dataset?.rename ? layerById(input.dataset.rename) : undefined;
    if (layer && renamingLayer === layer.id) renameLayer(layer, input.value);
  });

  topbar.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id !== 'map-name' || !state.map) return;
    state.map.name = input.value;
    state.dirty = true;
    renderTopbar();
  });

  topbar.addEventListener('focusout', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id !== 'map-name' || !state.map) return;
    if (!input.value.trim()) {
      state.map.name = UNTITLED;
      input.value = UNTITLED;
    }
  });

  topbar.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id === 'map-name' && e.key === 'Enter') input.blur();
  });

  root.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.slider) return;
    const value = Number(input.value) / 100;
    if (input.dataset.slider === 'overlay-opacity') {
      state.overlayOpacity = value;
    } else if (input.dataset.slider === 'layer-opacity') {
      layerById(input.dataset.id ?? null)!.opacity = value;
      state.dirty = true;
      renderTopbar();
    }
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

  zipInput.addEventListener('change', () => {
    const file = zipInput.files?.[0];
    zipInput.value = '';
    if (file) void importZip(file);
  });

  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (state.screen === 'library') {
      const zip = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
      if (zip) void importZip(zip);
      else showError('Drop a .zip here to import a map, or start a new map to add images.');
      return;
    }
    if (state.mode === 'view') state.mode = 'create';
    void addFiles(files);
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
    let moved = false;
    if (row?.dataset.index) {
      const r = row.getBoundingClientRect();
      let to = Number(row.dataset.index) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      if (to > dragIndex) to--;
      moved = to !== dragIndex;
      const [layer] = state.layers.splice(dragIndex, 1);
      state.layers.splice(to, 0, layer);
    }
    dragIndex = null;
    if (moved) edited();
    else changed();
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
    if (e.key === 'Escape') {
      if (openMenu) {
        openMenu = null;
        changed();
      } else {
        cancelPending();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (state.screen === 'editor' && state.dirty) void save();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.screen === 'editor' && state.dirty) e.preventDefault();
  });

  new ResizeObserver(requestDraw).observe(workspace);
  onChange(render);
  render();
  void refreshLibrary();
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

const EYE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="2"/></svg>`;
