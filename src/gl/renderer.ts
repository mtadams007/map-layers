import type { Rect } from '../camera';
import type { Transform } from '../fit';

/** Largest tile edge. Keeps each texture well inside every GPU's limit, including phones later. */
const MAX_TILE = 4096;
/** Smallest tile edge tried when the browser refuses larger tiles. */
const MIN_TILE = 1024;
/** Extra pixels copied around each tile so filtering doesn't show seams between tiles. */
const TILE_PAD = 8;

interface Tile {
  texture: WebGLTexture;
  /** Part of the layer this tile draws, in layer pixels. */
  rect: Rect;
  /** Where that part sits inside the texture, 0–1. */
  uv: [number, number, number, number];
}

interface GpuLayer {
  width: number;
  height: number;
  tiles: Tile[];
}

export interface Clip {
  /** Circle centre in pane CSS pixels. */
  x: number;
  y: number;
  radius: number;
}

export interface DrawOptions {
  /** Layer pixels → pane CSS pixels. */
  matrix: Transform;
  opacity: number;
  /** Show individual pixels as sharp squares when zoomed in (used by the loupe). */
  pixelated?: boolean;
  clip?: Clip;
}

const VERTEX = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;
uniform vec4 u_uv;
uniform mat3 u_matrix;
uniform vec2 u_viewport;
out vec2 v_uv;
void main() {
  vec2 layer = u_rect.xy + a_pos * u_rect.zw;
  vec2 screen = (u_matrix * vec3(layer, 1.0)).xy;
  vec2 ndc = screen / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec3 u_clip;
uniform vec4 u_fill;
out vec4 outColor;
void main() {
  if (u_clip.z > 0.0 && distance(gl_FragCoord.xy, u_clip.xy) > u_clip.z) discard;
  if (u_fill.a > 0.0) {
    outColor = u_fill;
    return;
  }
  // Textures hold premultiplied alpha, so opacity scales all four channels.
  outColor = texture(u_tex, v_uv) * u_opacity;
}`;

/**
 * Draws layers as textured quads with WebGL 2. One canvas covers the whole window and each pane is
 * a scissored viewport inside it, so every pane shares the same textures.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private smooth: WebGLSampler;
  private sharp: WebGLSampler;
  private layers = new Map<string, GpuLayer>();
  private dpr = 1;
  private pane: Rect = { x: 0, y: 0, width: 1, height: 1 };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('This browser does not support WebGL 2.');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    for (const name of ['u_rect', 'u_uv', 'u_matrix', 'u_viewport', 'u_tex', 'u_opacity', 'u_clip', 'u_fill']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    gl.uniform1i(this.uniforms.u_tex, 0);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.smooth = sampler(gl, gl.LINEAR);
    this.sharp = sampler(gl, gl.NEAREST);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
  }

  /** Match the canvas backing store to its CSS size. */
  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * this.dpr);
    const h = Math.round(this.canvas.clientHeight * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clearAll(color: [number, number, number]) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.scissor(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(color[0], color[1], color[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Restrict drawing to a pane, given in CSS pixels relative to the canvas. */
  beginPane(rect: Rect, background: [number, number, number]) {
    const gl = this.gl;
    this.pane = rect;
    const x = Math.round(rect.x * this.dpr);
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    const y = this.canvas.height - Math.round(rect.y * this.dpr) - h;
    gl.viewport(x, y, w, h);
    gl.scissor(x, y, w, h);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uniforms.u_viewport, rect.width, rect.height);
  }

  hasLayer(id: string): boolean {
    return this.layers.has(id);
  }

  /**
   * Split an image into tiles and upload each one. If the browser refuses a tile, try again with
   * smaller tiles before giving up. The caller still owns `source`.
   */
  async upload(id: string, source: ImageBitmap | HTMLImageElement, width: number, height: number) {
    let tileSize = Math.min(MAX_TILE, this.maxTextureSize);
    for (;;) {
      try {
        const tiles = this.uploadTiles(source, width, height, tileSize);
        this.remove(id);
        this.layers.set(id, { width, height, tiles });
        return;
      } catch (err) {
        if (tileSize <= MIN_TILE) throw err;
        tileSize = Math.max(MIN_TILE, tileSize / 2);
      }
    }
  }

  /**
   * Tiles are copied through one reused 2D canvas and uploaded as raw pixels with an explicit size.
   * Uploading ImageBitmap crops directly fails in Firefox ("Requested size at this level is
   * unsupported") and leaves every texture empty, which draws as black.
   */
  private uploadTiles(source: ImageBitmap | HTMLImageElement, width: number, height: number, tileSize: number): Tile[] {
    const gl = this.gl;
    const cols = splits(width, tileSize);
    const rows = splits(height, tileSize);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...cols.map((c) => c.srcSize));
    canvas.height = Math.max(...rows.map((r) => r.srcSize));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser could not prepare the image for drawing.');
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    // Clear any earlier error so it isn't blamed on this image.
    while (gl.getError() !== gl.NO_ERROR && !gl.isContextLost());
    const tiles: Tile[] = [];
    try {
      for (const row of rows) {
        for (const col of cols) {
          ctx.clearRect(0, 0, col.srcSize, row.srcSize);
          ctx.drawImage(source, col.src, row.src, col.srcSize, row.srcSize, 0, 0, col.srcSize, row.srcSize);
          const pixels = ctx.getImageData(0, 0, col.srcSize, row.srcSize).data;
          const texture = gl.createTexture()!;
          tiles.push({
            texture,
            rect: { x: col.start, y: row.start, width: col.size, height: row.size },
            uv: [
              (col.start - col.src) / col.srcSize,
              (row.start - row.src) / row.srcSize,
              (col.start + col.size - col.src) / col.srcSize,
              (row.start + row.size - row.src) / row.srcSize,
            ],
          });
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, col.srcSize, row.srcSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          this.checkError(`uploading a ${col.srcSize} × ${row.srcSize} px tile`);
          gl.generateMipmap(gl.TEXTURE_2D);
          this.checkError('preparing zoomed-out versions of the image');
        }
      }
    } catch (err) {
      for (const t of tiles) gl.deleteTexture(t.texture);
      throw err;
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      canvas.width = canvas.height = 0;
    }
    return tiles;
  }

  private checkError(step: string) {
    const gl = this.gl;
    const code = gl.getError();
    if (code === gl.NO_ERROR) return;
    const reason =
      code === gl.OUT_OF_MEMORY
        ? 'the graphics card ran out of memory'
        : `WebGL error 0x${code.toString(16)}; this browser's texture limit is ${this.maxTextureSize} px`;
    throw new Error(`The browser couldn't draw this image: ${reason} while ${step}.`);
  }

  remove(id: string) {
    const layer = this.layers.get(id);
    if (!layer) return;
    for (const t of layer.tiles) this.gl.deleteTexture(t.texture);
    this.layers.delete(id);
  }

  /** Paint a solid circle in the current pane, replacing what is there. */
  fillCircle(clip: Clip, color: [number, number, number]) {
    const gl = this.gl;
    this.setMatrix([1, 0, 0, 0, 1, 0]);
    this.setClip(clip);
    gl.uniform4f(this.uniforms.u_fill, color[0], color[1], color[2], 1);
    gl.uniform4f(this.uniforms.u_rect, 0, 0, this.pane.width, this.pane.height);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.uniform4f(this.uniforms.u_fill, 0, 0, 0, 0);
  }

  draw(id: string, opts: DrawOptions) {
    const layer = this.layers.get(id);
    if (!layer || opts.opacity <= 0) return;
    const gl = this.gl;
    this.setMatrix(opts.matrix);
    this.setClip(opts.clip);
    gl.uniform1f(this.uniforms.u_opacity, opts.opacity);
    gl.bindSampler(0, opts.pixelated ? this.sharp : this.smooth);
    gl.activeTexture(gl.TEXTURE0);
    for (const t of layer.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.uniform4f(this.uniforms.u_rect, t.rect.x, t.rect.y, t.rect.width, t.rect.height);
      gl.uniform4f(this.uniforms.u_uv, t.uv[0], t.uv[1], t.uv[2], t.uv[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private setMatrix([a, b, c, d, e, f]: Transform) {
    // Column-major mat3.
    this.gl.uniformMatrix3fv(this.uniforms.u_matrix, false, [a, d, 0, b, e, 0, c, f, 1]);
  }

  private setClip(clip?: Clip) {
    if (!clip) {
      this.gl.uniform3f(this.uniforms.u_clip, 0, 0, 0);
      return;
    }
    // gl_FragCoord is in device pixels from the canvas's bottom-left corner.
    const cx = (this.pane.x + clip.x) * this.dpr;
    const cy = this.canvas.height - (this.pane.y + clip.y) * this.dpr;
    this.gl.uniform3f(this.uniforms.u_clip, cx, cy, clip.radius * this.dpr);
  }
}

interface Split {
  /** Start and size of the part drawn from this tile. */
  start: number;
  size: number;
  /** Start and size of the pixels copied into the texture, including padding. */
  src: number;
  srcSize: number;
}

/** Divide one image axis into tile spans whose padded size fits within `tileSize`. */
export function splits(length: number, tileSize: number): Split[] {
  if (length <= tileSize) return [{ start: 0, size: length, src: 0, srcSize: length }];
  const step = tileSize - 2 * TILE_PAD;
  const out: Split[] = [];
  for (let start = 0; start < length; start += step) {
    const size = Math.min(step, length - start);
    const src = Math.max(0, start - TILE_PAD);
    const end = Math.min(length, start + size + TILE_PAD);
    out.push({ start, size, src, srcSize: end - src });
  }
  return out;
}

function sampler(gl: WebGL2RenderingContext, mag: number): WebGLSampler {
  const s = gl.createSampler()!;
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
