// The project.json format: everything about a map except the image pixels.
// The same structure is kept in on-device storage and written into exported zips.

import type { FitMode, Transform, Vec } from './fit';

export const FORMAT_VERSION = 1;

export interface ProjectPoint {
  layer: Vec;
  base: Vec;
}

export interface ProjectLayer {
  id: string;
  name: string;
  /** Path of the original image inside the zip, e.g. "layers/<id>.png". */
  file: string;
  /** Downscaled copy for phones; not written yet. */
  phoneFile: string | null;
  width: number;
  height: number;
  /** Draw order: 0 is drawn on top. */
  order: number;
  visible: boolean;
  alignment: {
    mode: FitMode;
    points: ProjectPoint[];
    /** Layer pixels → base pixels, or null while the layer has too few points. */
    transform: Transform | null;
  };
  appearance: {
    opacity: number;
    brightness: number;
    contrast: number;
    saturation: number;
    hue: number;
    recolor: string | null;
  };
}

export interface Project {
  formatVersion: number;
  id: string;
  name: string;
  /** ISO 8601 dates. */
  created: string;
  modified: string;
  viewOnly: boolean;
  baseLayerId: string | null;
  layers: ProjectLayer[];
}

export const DEFAULT_APPEARANCE: ProjectLayer['appearance'] = {
  opacity: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  recolor: null,
};

export const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

export function mimeForFile(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return null;
}

/** Thrown for project files this app can't read; the message is shown to the user. */
export class ProjectError extends Error {}

/**
 * Check a parsed project.json and bring it up to the current format. Accepts anything (it may come
 * from a file someone sent) and returns a fully valid Project, or throws a ProjectError.
 */
export function readProject(raw: unknown): Project {
  if (!isObject(raw)) throw new ProjectError("This isn't a Map Layers project file.");
  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProjectError("This isn't a Map Layers project file (no format version).");
  }
  if (version > FORMAT_VERSION) {
    throw new ProjectError('This map was made with a newer version of Map Layers. Update the app to open it.');
  }
  // Older versions are upgraded here, one step at a time, as the format changes.
  return validateV1(raw);
}

function validateV1(raw: Record<string, unknown>): Project {
  const layersRaw = raw.layers;
  if (!Array.isArray(layersRaw)) throw bad('layers');
  const layers = layersRaw.map((l, i) => validateLayer(l, i));
  const ids = new Set(layers.map((l) => l.id));
  if (ids.size !== layers.length) throw bad('layer ids');
  const baseLayerId = raw.baseLayerId === null || raw.baseLayerId === undefined ? null : str(raw.baseLayerId, 'baseLayerId');
  if (baseLayerId !== null && !ids.has(baseLayerId)) throw bad('baseLayerId');
  if (baseLayerId === null && layers.length > 0) throw bad('baseLayerId');
  return {
    formatVersion: FORMAT_VERSION,
    id: str(raw.id, 'id'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled map',
    created: date(raw.created),
    modified: date(raw.modified),
    viewOnly: raw.viewOnly === true,
    baseLayerId,
    layers: layers.sort((a, b) => a.order - b.order),
  };
}

function validateLayer(raw: unknown, index: number): ProjectLayer {
  if (!isObject(raw)) throw bad(`layer ${index + 1}`);
  const file = str(raw.file, 'layer file');
  if (!mimeForFile(file) || file.includes('..') || file.startsWith('/')) throw bad('layer file');
  const alignment = isObject(raw.alignment) ? raw.alignment : {};
  const appearance = isObject(raw.appearance) ? raw.appearance : {};
  const points = Array.isArray(alignment.points) ? alignment.points : [];
  return {
    id: str(raw.id, 'layer id'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Layer ${index + 1}`,
    file,
    phoneFile: typeof raw.phoneFile === 'string' ? raw.phoneFile : null,
    width: positiveInt(raw.width, 'layer width'),
    height: positiveInt(raw.height, 'layer height'),
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index,
    visible: raw.visible !== false,
    alignment: {
      mode: alignment.mode === 'affine' ? 'affine' : 'similarity',
      points: points.map((p) => {
        if (!isObject(p)) throw bad('alignment point');
        return { layer: vec(p.layer), base: vec(p.base) };
      }),
      transform: isTransform(alignment.transform) ? alignment.transform : null,
    },
    appearance: {
      opacity: clamp01(appearance.opacity, DEFAULT_APPEARANCE.opacity),
      brightness: num(appearance.brightness, 0),
      contrast: num(appearance.contrast, 0),
      saturation: num(appearance.saturation, 0),
      hue: num(appearance.hue, 0),
      recolor: typeof appearance.recolor === 'string' && /^#[0-9a-f]{6}$/i.test(appearance.recolor) ? appearance.recolor : null,
    },
  };
}

function bad(what: string) {
  return new ProjectError(`This project file is damaged (${what}).`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw bad(what);
  return v;
}

function positiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw bad(what);
  return v;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: unknown, fallback: number): number {
  return Math.min(1, Math.max(0, num(v, fallback)));
}

function vec(v: unknown): Vec {
  if (!isObject(v) || typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y)) {
    throw bad('alignment point');
  }
  return { x: v.x, y: v.y };
}

function isTransform(v: unknown): v is Transform {
  return Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function date(v: unknown): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString();
}
