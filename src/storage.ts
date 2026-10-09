// The on-device library, kept in IndexedDB. One record per map (its project.json and thumbnail)
// plus one record per layer image. The exported zip, not this, is the real backup.

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

interface StoredImage {
  /** `${projectId}/${layerId}` */
  key: string;
  projectId: string;
  blob: Blob;
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
  const all = await request(tx.objectStore(PROJECTS).getAll() as IDBRequest<StoredProject[]>);
  return all.sort((a, b) => b.project.modified.localeCompare(a.project.modified));
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const tx = (await db()).transaction(PROJECTS);
  return request(tx.objectStore(PROJECTS).get(id) as IDBRequest<StoredProject | undefined>);
}

export async function getImages(project: Project): Promise<Map<string, Blob>> {
  const tx = (await db()).transaction(IMAGES);
  const store = tx.objectStore(IMAGES);
  const images = new Map<string, Blob>();
  for (const layer of project.layers) {
    const rec = await request(store.get(`${project.id}/${layer.id}`) as IDBRequest<StoredImage | undefined>);
    if (rec) images.set(layer.id, rec.blob);
  }
  return images;
}

/**
 * Save a map. `newImages` holds only images not stored yet (keyed by layer id); stored images of
 * layers that are no longer in the map are deleted. Everything happens in one transaction, so a
 * failed save leaves the previous version intact.
 */
export async function saveProject(project: Project, newImages: Map<string, Blob>, thumbnail: Blob | null) {
  const tx = (await db()).transaction([PROJECTS, IMAGES], 'readwrite');
  const images = tx.objectStore(IMAGES);
  for (const [layerId, blob] of newImages) {
    images.put({ key: `${project.id}/${layerId}`, projectId: project.id, blob } satisfies StoredImage);
  }
  const keep = new Set(project.layers.map((l) => `${project.id}/${l.id}`));
  const keys = await request(images.index('projectId').getAllKeys(project.id));
  for (const key of keys) if (!keep.has(String(key))) images.delete(key);
  tx.objectStore(PROJECTS).put({ id: project.id, project, thumbnail } satisfies StoredProject);
  await done(tx);
  void requestPersistence();
}

export async function renameProject(id: string, name: string) {
  const tx = (await db()).transaction(PROJECTS, 'readwrite');
  const store = tx.objectStore(PROJECTS);
  const rec = await request(store.get(id) as IDBRequest<StoredProject | undefined>);
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
