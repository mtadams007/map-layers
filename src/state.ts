import { fit, IDENTITY, outliers, type FitResult, type Transform, type Vec } from './fit';

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
  thumbnail: string;
  points: ControlPoint[];
  pending: PendingPoint | null;
  visible: boolean;
  opacity: number;
}

export interface LoadingLayer {
  key: number;
  name: string;
}

export type Mode = 'create' | 'view';
export type CreateView = 'side' | 'overlay';

export interface FitSummary {
  similarity: FitResult | null;
  affine: FitResult | null;
  outliers: boolean[];
}

/** Everything the screen shows. Nothing here is saved yet; that comes in phase 2. */
export interface AppState {
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
    summary = {
      similarity,
      affine: fit('affine', layer.points),
      outliers: similarity ? outliers(similarity.errors) : layer.points.map(() => false),
    };
    fitCache.set(layer.id, summary);
  }
  return summary;
}

/** Drop the cached fit for a layer whose points moved, without re-rendering the panels. */
export function pointsMoved(layer: Layer) {
  fitCache.delete(layer.id);
}

/** Layer pixels → base pixels, or null while the layer has too few points. */
export function transformOf(layer: Layer): Transform | null {
  if (layer.id === state.baseId) return IDENTITY;
  return fitSummary(layer).similarity?.transform ?? null;
}

let nextPointId = 1;

export function newPointId(): number {
  return nextPointId++;
}
