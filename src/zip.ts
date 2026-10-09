import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { mimeForFile, ProjectError, readProject, type Project } from './project';

/** Largest zip the importer will open. Each image is held in memory several times while loading. */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

/**
 * Build the project zip: project.json, thumbnail.png and the original images under layers/.
 * Images are stored without recompression; PNG and JPEG are already compressed.
 */
export async function buildZip(project: Project, images: Map<string, Blob>, thumbnail: Blob | null): Promise<Blob> {
  const files: Zippable = {
    'project.json': [strToU8(JSON.stringify(project, null, 2)), { level: 6 }],
  };
  if (thumbnail) files['thumbnail.png'] = [await bytes(thumbnail), { level: 0 }];
  for (const layer of project.layers) {
    const blob = images.get(layer.id);
    if (!blob) throw new Error(`The image for "${layer.name}" is missing, so the map can't be exported.`);
    files[layer.file] = [await bytes(blob), { level: 0 }];
  }
  const zipped = zipSync(files);
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

export interface ImportedProject {
  project: Project;
  /** Original image per layer id. */
  images: Map<string, Blob>;
  thumbnail: Blob | null;
}

export async function readZip(file: Blob): Promise<ImportedProject> {
  if (file.size > MAX_ZIP_BYTES) throw new ProjectError('This file is larger than 1 GB, too large to open.');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await bytes(file));
  } catch {
    throw new ProjectError("This file isn't a zip, or it is damaged.");
  }
  const json = entries['project.json'];
  if (!json) throw new ProjectError("This zip doesn't contain a Map Layers project (no project.json).");
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json));
  } catch {
    throw new ProjectError('The project.json in this zip is damaged.');
  }
  const project = readProject(raw);
  const images = new Map<string, Blob>();
  for (const layer of project.layers) {
    const data = entries[layer.file];
    if (!data) throw new ProjectError(`The image for "${layer.name}" is missing from this zip.`);
    // Pass the view itself: fflate may return a slice of the whole zip's buffer.
    images.set(layer.id, new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeForFile(layer.file)! }));
  }
  const thumb = entries['thumbnail.png'];
  const thumbnail = thumb ? new Blob([thumb as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : null;
  return { project, images, thumbnail };
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
