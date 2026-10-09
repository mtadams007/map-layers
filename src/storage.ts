// The on-device library, kept in IndexedDB. One record per map (its project.json and thumbnail)
// plus one record per layer image. The exported zip, not this, is the real backup.
// Images are stored as raw bytes, not Blobs: Safari on iPhone refuses to store Blobs in IndexedDB
// ("BlobURLs are not yet supported"). Records saved earlier as Blobs are still read.

import type { Project } from './project';

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

function toProject(rec: ProjectRecord): StoredProject {
  return { id: rec.id, project: rec.project, thumbnail: fromStored(rec.thumbnail) };
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
  const all = (await request(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>)).map(toProject);
  return all.sort((a, b) => b.project.modified.localeCompare(a.project.modified));
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const tx = (await db()).transaction(PROJECTS);
  const rec = await request(tx.objectStore(PROJECTS).get(id) as IDBRequest<ProjectRecord | undefined>);
  return rec && toProject(rec);
}

export async function getImages(project: Project): Promise<Map<string, Blob>> {
  const tx = (await db()).transaction(IMAGES);
  const store = tx.objectStore(IMAGES);
  const images = new Map<string, Blob>();
  for (const layer of project.layers) {
    const rec = await request(store.get(`${project.id}/${layer.id}`) as IDBRequest<ImageRecord | undefined>);
    const blob = fromStored(rec?.file ?? rec?.blob);
    if (blob) images.set(layer.id, blob);
  }
  return images;
}

/**
 * Save a map. `newImages` holds only images not stored yet (keyed by layer id); stored images of
 * layers that are no longer in the map are deleted. Everything happens in one transaction, so a
 * failed save leaves the previous version intact.
 */
export async function saveProject(project: Project, newImages: Map<string, Blob>, thumbnail: Blob | null) {
  // Read every file before opening the transaction: awaiting other work inside it would end it.
  const files = new Map<string, StoredFile>();
  for (const [layerId, blob] of newImages) files.set(layerId, await toStored(blob));
  const thumb = thumbnail ? await toStored(thumbnail) : null;

  const tx = (await db()).transaction([PROJECTS, IMAGES], 'readwrite');
  const images = tx.objectStore(IMAGES);
  for (const [layerId, file] of files) {
    images.put({ key: `${project.id}/${layerId}`, projectId: project.id, file } satisfies ImageRecord);
  }
  const keep = new Set(project.layers.map((l) => `${project.id}/${l.id}`));
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
