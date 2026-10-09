import type { StoredProject } from '../storage';
import { esc } from './html';

const urls: string[] = [];

/** Install help shown on phones: iPhone needs instructions, Android has a browser prompt. */
export type InstallHelp = 'ios' | 'android' | null;

export interface LibraryOptions {
  /** Phones can't create maps, only import and view them. */
  phone: boolean;
  install: InstallHelp;
}

/** Library page markup. Thumbnail object URLs from the previous render are released. */
export function libraryHtml(maps: StoredProject[] | null, openMenu: string | null, opts: LibraryOptions): string {
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  const cards =
    maps === null
      ? '<p class="muted">Loading your maps…</p>'
      : maps.length === 0
        ? `<div class="library-empty">
             <h2>No maps yet</h2>
             <p class="muted">${
               opts.phone
                 ? 'Import a .zip exported from Map Layers on a laptop. Maps are made and aligned on a laptop.'
                 : 'Start a new map from your images, or import a .zip someone sent you.'
             }</p>
           </div>`
        : `<ul class="map-grid">${maps.map((m) => cardHtml(m, openMenu === m.id)).join('')}</ul>`;
  return `
    <div class="library">
      <div class="library-head">
        <h1>Maps</h1>
        <span class="spacer"></span>
        ${
          opts.phone
            ? '<button class="button primary" data-action="import">Import .zip</button>'
            : `<button class="button" data-action="import">Import .zip</button>
               <button class="button primary" data-action="new-map">+ New map</button>`
        }
      </div>
      ${installHtml(opts.install)}
      ${cards}
      <aside class="notice">
        <strong>Keep your .zip files</strong>
        <p>Maps are stored only in this browser on this ${opts.phone ? 'phone' : 'device'}, and the browser can clear that storage.
        Keep the .zip of each map in Drive or Files as a backup.</p>
      </aside>
    </div>`;
}

function installHtml(help: InstallHelp): string {
  if (!help) return '';
  const body =
    help === 'ios'
      ? `<p>Add it to your Home Screen to use it like an app, including offline: tap the
         <strong>Share</strong> button <span aria-hidden="true">(□↑)</span> in Safari, then
         <strong>Add to Home Screen</strong>.</p>`
      : `<p>Install it to use it like an app, including offline.</p>
         <button class="button primary" data-action="install">Install</button>`;
  return `
    <aside class="install-card">
      <div><strong>Install Map Layers</strong>${body}</div>
      <button class="icon" data-action="dismiss-install" aria-label="Dismiss">×</button>
    </aside>`;
}

function cardHtml(m: StoredProject, menuOpen: boolean): string {
  const p = m.project;
  let thumb = '<div class="map-thumb"></div>';
  if (m.thumbnail) {
    const url = URL.createObjectURL(m.thumbnail);
    urls.push(url);
    thumb = `<img class="map-thumb" src="${url}" alt="">`;
  }
  const n = p.layers.length;
  return `
    <li class="map-card" data-action="open" data-id="${p.id}">
      ${thumb}
      <div class="map-text">
        <div class="map-name">${esc(p.name)}</div>
        <div class="muted small">${n} layer${n === 1 ? '' : 's'} · edited ${formatDate(p.modified)}</div>
      </div>
      <button class="icon menu-button" data-action="map-menu" data-id="${p.id}" aria-label="More actions for ${esc(p.name)}" aria-expanded="${menuOpen}">•••</button>
      ${
        menuOpen
          ? `<div class="menu" role="menu">
               <button role="menuitem" data-action="rename-map" data-id="${p.id}">Rename</button>
               <button role="menuitem" data-action="export-map" data-id="${p.id}">Export .zip</button>
               <button role="menuitem" class="danger" data-action="delete-map" data-id="${p.id}">Delete from this device</button>
             </div>`
          : ''
      }
    </li>`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}
