import { fit, IDENTITY, MIN_POINTS, outliers, type FitMode, type FitResult, type Transform, type Vec } from './fit';
import { DEFAULT_APPEARANCE, FORMAT_VERSION, IMAGE_EXTENSIONS, type Project } from './project';

export interface ControlPoint {
  id: number;
  /** Position on the layer, in layer pixels. */
  layer: Vec;
  /** The same feature on the base layer, in base pixels. */
  base: Vec;
}

/** A point that has been clicked on one side but not yet on the other. */
export interface PendingPoint {
  layer?: Vec;
  base?: Vec;
}

export interface Layer {
  id: string;
  name: string;
  width: number;
  height: number;
  /**
   * The original image file, kept for saving and export. Null on a phone that opened the phone
   * copy: the original stays in storage and is only read if the map is exported there.
   */
  file: Blob | null;
  /** Media type of the original, e.g. image/jpeg. */
  fileType: string;
  /** Whether `file` is already in on-device storage, so a save can skip it. */
  stored: boolean;
  /** Smaller copies for devices with little memory, largest first; empty for small layers. */
  phoneCopies: LayerPhoneCopy[];
  thumbnail: string;
  points: ControlPoint[];
  pending: PendingPoint | null;
  fitMode: FitMode;
  visible: boolean;
  opacity: number;
}

export interface LayerPhoneCopy {
  /** Path in the zip. */
  file: string;
  maxSide: number;
  width: number;
  height: number;
  /** The image, or null while it is only in on-device storage (not needed on this device). */
  blob: Blob | null;
  /** Whether it is already in on-device storage, so a save can skip it. */
  stored: boolean;
}

/** Path in the zip for a new phone copy. */
export function phoneCopyPath(layerId: string, maxSide: number, type: string): string {
  return `layers-phone/${layerId}-${maxSide}.${IMAGE_EXTENSIONS[type] ?? 'png'}`;
}

export interface LoadingLayer {
  key: number;
  name: string;
}

export type Screen = 'library' | 'editor';
export type Mode = 'create' | 'view';
export type CreateView = 'side' | 'overlay';

/** The open map, apart from its layers. */
export interface MapInfo {
  id: string;
  name: string;
  created: string;
}

export interface FitSummary {
  similarity: FitResult | null;
  affine: FitResult | null;
  /** The fit in use: affine when chosen and possible, otherwise similarity. */
  active: FitResult | null;
  outliers: boolean[];
}

export interface AppState {
  screen: Screen;
  map: MapInfo | null;
  /** The open map has changes that aren't saved. */
  dirty: boolean;
  /** Draw order: index 0 is drawn on top. */
  layers: Layer[];
  loading: LoadingLayer[];
  baseId: string | null;
  /** The layer being aligned in Create mode. */
  selectedId: string | null;
  mode: Mode;
  createView: CreateView;
  overlayOpacity: number;
}

export const state: AppState = {
  screen: 'library',
  map: null,
  dirty: false,
  layers: [],
  loading: [],
  baseId: null,
  selectedId: null,
  mode: 'create',
  createView: 'side',
  overlayOpacity: 0.6,
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Something changed that the panels need to show. */
export function changed() {
  fitCache.clear();
  for (const l of listeners) l();
}

/** The map itself changed and needs saving. */
export function edited() {
  state.dirty = true;
  changed();
}

export function onChange(l: Listener) {
  listeners.add(l);
}

export function layerById(id: string | null): Layer | undefined {
  return state.layers.find((l) => l.id === id);
}

export function baseLayer(): Layer | undefined {
  return layerById(state.baseId);
}

export function selectedLayer(): Layer | undefined {
  return layerById(state.selectedId);
}

const fitCache = new Map<string, FitSummary>();

export function fitSummary(layer: Layer): FitSummary {
  let summary = fitCache.get(layer.id);
  if (!summary) {
    const similarity = fit('similarity', layer.points);
    const affine = fit('affine', layer.points);
    const active = layer.fitMode === 'affine' && affine ? affine : similarity;
    summary = {
      similarity,
      affine,
      active,
      outliers: active ? outliers(active.errors) : layer.points.map(() => false),
    };
    fitCache.set(layer.id, summary);
  }
  return summary;
}

/** Whether the affine option can be chosen for this layer. */
export function canUseAffine(layer: Layer): boolean {
  return layer.points.length >= MIN_POINTS.affine;
}

/** Drop the cached fit for a layer whose points moved, without re-rendering the panels. */
export function pointsMoved(layer: Layer) {
  fitCache.delete(layer.id);
}

/** Layer pixels → base pixels, or null while the layer has too few points. */
export function transformOf(layer: Layer): Transform | null {
  if (layer.id === state.baseId) return IDENTITY;
  return fitSummary(layer).active?.transform ?? null;
}

let nextPointId = 1;

export function newPointId(): number {
  return nextPointId++;
}

/** The open map as a project.json. Half-placed points are not saved. */
export function toProject(modified: string): Project {
  const map = state.map!;
  return {
    formatVersion: FORMAT_VERSION,
    id: map.id,
    name: map.name,
    created: map.created,
    modified,
    viewOnly: false,
    baseLayerId: state.baseId,
    layers: state.layers.map((l, order) => ({
      id: l.id,
      name: l.name,
      file: `layers/${l.id}.${IMAGE_EXTENSIONS[l.fileType] ?? 'png'}`,
      phoneCopies: l.phoneCopies.map(({ file, maxSide, width, height }) => ({ file, maxSide, width, height })),
      width: l.width,
      height: l.height,
      order,
      visible: l.visible,
      alignment: {
        mode: l.fitMode,
        points: l.points.map((p) => ({ layer: { ...p.layer }, base: { ...p.base } })),
        transform: transformOf(l),
      },
      appearance: { ...DEFAULT_APPEARANCE, opacity: l.opacity },
    })),
  };
}
