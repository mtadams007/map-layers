import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, ProjectError, readProject, type Project } from './project';
import { buildZip, readZip } from './zip';

function sample(): Project {
  return {
    formatVersion: 1,
    id: 'map-1',
    name: 'Harbour map',
    created: '2026-10-08T10:00:00.000Z',
    modified: '2026-10-09T10:00:00.000Z',
    viewOnly: false,
    baseLayerId: 'base',
    layers: [
      {
        id: 'roads',
        name: 'Roads',
        file: 'layers/roads.png',
        phoneFile: null,
        width: 2480,
        height: 1650,
        order: 0,
        visible: true,
        alignment: {
          mode: 'affine',
          points: [{ layer: { x: 1, y: 2 }, base: { x: 3, y: 4 } }],
          transform: [1, 0, 0, 0, 1, 0],
        },
        appearance: { opacity: 0.8, brightness: 0, contrast: 0, saturation: 0, hue: 0, recolor: '#dd4499' },
      },
      {
        id: 'base',
        name: 'Survey base',
        file: 'layers/base.jpg',
        phoneFile: null,
        width: 4000,
        height: 3000,
        order: 1,
        visible: true,
        alignment: { mode: 'similarity', points: [], transform: [1, 0, 0, 0, 1, 0] },
        appearance: { opacity: 1, brightness: 0, contrast: 0, saturation: 0, hue: 0, recolor: null },
      },
    ],
  };
}

describe('readProject', () => {
  it('accepts a valid project unchanged', () => {
    expect(readProject(JSON.parse(JSON.stringify(sample())))).toEqual(sample());
  });

  it('rejects files from a newer version and non-projects', () => {
    expect(() => readProject({ ...sample(), formatVersion: FORMAT_VERSION + 1 })).toThrow(/newer version/);
    expect(() => readProject({ hello: 'world' })).toThrow(ProjectError);
    expect(() => readProject('nope')).toThrow(ProjectError);
  });

  it('rejects damaged references and unsafe paths', () => {
    expect(() => readProject({ ...sample(), baseLayerId: 'missing' })).toThrow(/baseLayerId/);
    const p = sample();
    p.layers[0].file = '../../etc/passwd.png';
    expect(() => readProject(p)).toThrow(/layer file/);
    const q = sample();
    q.layers[1].id = 'roads';
    expect(() => readProject(q)).toThrow(/layer ids/);
  });

  it('fills safe defaults for optional fields and sorts by order', () => {
    const raw = JSON.parse(JSON.stringify(sample()));
    raw.layers.reverse();
    delete raw.layers[0].appearance;
    raw.layers[1].alignment.transform = 'bad';
    const p = readProject(raw);
    expect(p.layers.map((l) => l.id)).toEqual(['roads', 'base']);
    expect(p.layers[1].appearance.opacity).toBe(1);
    expect(p.layers[0].alignment.transform).toBeNull();
  });
});

describe('zip round trip', () => {
  it('keeps the project, images and thumbnail', async () => {
    const project = sample();
    const images = new Map([
      ['roads', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })],
      ['base', new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'image/jpeg' })],
    ]);
    const zip = await buildZip(project, images, new Blob([new Uint8Array([5])], { type: 'image/png' }));
    const back = await readZip(zip);
    expect(back.project).toEqual(project);
    expect([...new Uint8Array(await back.images.get('base')!.arrayBuffer())]).toEqual([9, 8, 7, 6]);
    expect(back.images.get('roads')!.type).toBe('image/png');
    expect(back.thumbnail).not.toBeNull();
  });

  it('reports a zip without a project', async () => {
    const { zipSync } = await import('fflate');
    const zip = new Blob([zipSync({ 'readme.txt': new Uint8Array([1]) })]);
    await expect(readZip(zip)).rejects.toThrow(/no project.json/);
    await expect(readZip(new Blob(['not a zip']))).rejects.toThrow(/isn't a zip/);
  });
});
