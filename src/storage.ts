// The on-device library, kept in IndexedDB. One record per map (its project.json and thumbnail)
// plus one record per layer image. The exported zip, not this, is the real backup.
// Images are stored as raw bytes, not Blobs: Safari on iPhone refuses to store Blobs in IndexedDB
// ("BlobURLs are not yet supported"). Records saved earlier as Blobs are still read.

import { readProject, type Project, type ProjectPhoneCopy } from './project';

const DB_NAME = 'map-layers';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const IMAGES = 'images';

export interface StoredProject {
  id: string;
  project: Project;
  thumbnail: Blob | null;
}

/** A file as stored: its bytes and media type. */
interface StoredFile {
  data: ArrayBuffer;
  type: string;
}

interface ProjectRecord {
  id: string;
  project: Project;
  /** Older records hold a Blob. */
  thumbnail: StoredFile | Blob | null;
}

interface ImageRecord {
  /** `${projectId}/${layerId}` */
  key: string;
  projectId: string;
  file?: StoredFile;
  /** Older records hold a Blob instead of `file`. */
  blob?: Blob;
}

async function toStored(blob: Blob): Promise<StoredFile> {
  return { data: await blob.arrayBuffer(), type: blob.type };
}

function fromStored(f: StoredFile | Blob | null | undefined): Blob | null {
  if (!f) return null;
  if (f instanceof Blob) return f;
  return new Blob([f.data], { type: f.type });
}

/** Stored maps go through the same checks as imported ones, so older formats are upgraded. */
function toProject(rec: ProjectRecord): StoredProject | null {
  try {
    return { id: rec.id, project: readProject(rec.project), thumbnail: fromStored(rec.thumbnail) };
  } catch {
    return null;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(PROJECTS)) d.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(IMAGES)) {
        d.createObjectStore(IMAGES, { keyPath: 'key' }).createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(new Error("This browser won't let the app store maps. Private windows often block it."));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(storageError(tx.error));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error));
  });
}

function storageError(err: DOMException | null): Error {
  if (err?.name === 'QuotaExceededError') {
    return new Error('There is no room left to store this map on this device. Delete a map or free up space.');
  }
  return new Error(`The map couldn't be stored (${err?.message ?? 'unknown error'}).`);
}

export async function listProjects(): Promise<StoredProject[]> {
  const tx = (await db()).transaction(PROJECTS);
  const all = (await request(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>))
    .map(toProject)
    .filter((p): p is StoredProject => p !== null);
  return all.sort((a, b) => b.project.modified.localeCompare(a.project.modified));
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const tx = (await db()).transaction(PROJECTS);
  const rec = await request(tx.objectStore(PROJECTS).get(id) as IDBRequest<ProjectRecord | undefined>);
  return (rec && toProject(rec)) ?? undefined;
}

function originalKey(projectId: string, layerId: string): string {
  return `${projectId}/${layerId}`;
}

/**
 * Storage key of a phone copy. Copies saved before format version 2 (one per layer, named
 * layers-phone/<layer id>.jpg) keep the key they were stored under.
 */
function phoneKey(projectId: string, layerId: string, copy: ProjectPhoneCopy): string {
  const legacy = new RegExp(`^layers-phone/${layerId}\\.(jpg|png)$`).test(copy.file);
  return legacy ? `${projectId}/${layerId}/phone` : `${projectId}/${layerId}/phone-${copy.maxSide}`;
}

async function readBlob(store: IDBObjectStore, key: string): Promise<Blob | null> {
  const rec = await request(store.get(key) as IDBRequest<ImageRecord | undefined>);
  return fromStored(rec?.file ?? rec?.blob);
}

/**
 * Original images keyed by layer id. `only` limits it to some layers, so a phone needn't load
 * originals it won't draw.
 */
export async function getImages(project: Project, only?: Set<string>): Promise<Map<string, Blob>> {
  const store = (await db()).transaction(IMAGES).objectStore(IMAGES);
  const images = new Map<string, Blob>();
  for (const layer of project.layers) {
    if (only && !only.has(layer.id)) continue;
    const blob = await readBlob(store, originalKey(project.id, layer.id));
    if (blob) images.set(layer.id, blob);
  }
  return images;
}

/** Phone copies keyed by their path in the zip. `only` limits it to some paths. */
export async function getPhoneCopies(project: Project, only?: Set<string>): Promise<Map<string, Blob>> {
  const store = (await db()).transaction(IMAGES).objectStore(IMAGES);
  const copies = new Map<string, Blob>();
  for (const layer of project.layers) {
    for (const copy of layer.phoneCopies) {
      if (only && !only.has(copy.file)) continue;
      const blob = await readBlob(store, phoneKey(project.id, layer.id, copy));
      if (blob) copies.set(copy.file, blob);
    }
  }
  return copies;
}

/**
 * Save a map. `newImages` (originals by layer id) and `newPhoneCopies` (by path) hold only images
 * not stored yet; stored images the map no longer uses are deleted. Everything happens in one
 * transaction, so a failed save leaves the previous version intact.
 */
export async function saveProject(
  project: Project,
  newImages: Map<string, Blob>,
  newPhoneCopies: Map<string, Blob>,
  thumbnail: Blob | null,
) {
  // Read every file before opening the transaction: awaiting other work inside it would end it.
  const files = new Map<string, StoredFile>();
  for (const [layerId, blob] of newImages) files.set(originalKey(project.id, layerId), await toStored(blob));
  for (const layer of project.layers) {
    for (const copy of layer.phoneCopies) {
      const blob = newPhoneCopies.get(copy.file);
      if (blob) files.set(phoneKey(project.id, layer.id, copy), await toStored(blob));
    }
  }
  const thumb = thumbnail ? await toStored(thumbnail) : null;

  const tx = (await db()).transaction([PROJECTS, IMAGES], 'readwrite');
  const images = tx.objectStore(IMAGES);
  for (const [key, file] of files) {
    images.put({ key, projectId: project.id, file } satisfies ImageRecord);
  }
  const keep = new Set(
    project.layers.flatMap((l) => [originalKey(project.id, l.id), ...l.phoneCopies.map((c) => phoneKey(project.id, l.id, c))]),
  );
  const keys = await request(images.index('projectId').getAllKeys(project.id));
  for (const key of keys) if (!keep.has(String(key))) images.delete(key);
  tx.objectStore(PROJECTS).put({ id: project.id, project, thumbnail: thumb } satisfies ProjectRecord);
  await done(tx);
  void requestPersistence();
}

export async function renameProject(id: string, name: string) {
  const tx = (await db()).transaction(PROJECTS, 'readwrite');
  const store = tx.objectStore(PROJECTS);
  const rec = await request(store.get(id) as IDBRequest<ProjectRecord | undefined>);
  if (rec) {
    rec.project.name = name;
    rec.project.modified = new Date().toISOString();
    store.put(rec);
  }
  await done(tx);
}

export async function deleteProject(id: string) {
  const tx = (await db()).transaction([PROJECTS, IMAGES], 'readwrite');
  tx.objectStore(PROJECTS).delete(id);
  const images = tx.objectStore(IMAGES);
  const keys = await request(images.index('projectId').getAllKeys(id));
  for (const key of keys) images.delete(key);
  await done(tx);
}

/** Ask the browser not to clear the library under storage pressure. Some browsers ask the user. */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Not supported; the zip export is the backup either way.
  }
}
