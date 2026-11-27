'use strict';
// Shared by the page and the worker: drawing scenes and hashing.
async function sha(data) {
  let buf;
  if (typeof data === 'string') buf = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) buf = data;
  else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  else buf = new TextEncoder().encode(JSON.stringify(data));
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'step') + ' timeout')), ms))]);
}

function drawScene(ctx, w, h) {
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = '#069'; ctx.font = '11pt "Times New Roman"'; ctx.fillText('Cwm fjordbank gly \u{1F603}', 2, 15);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.2)'; ctx.font = '18pt Arial'; ctx.fillText('Cwm fjordbank gly \u{1F603}', 4, 45);
  ctx.globalCompositeOperation = 'multiply';
  for (const [c, x, y] of [['#f2f', 40, 40], ['#2ff', 80, 40], ['#ff2', 60, 80]]) {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y + 20, 40, 0, Math.PI * 2, true); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#f9c'; ctx.beginPath(); ctx.arc(200, 80, 50, 0, Math.PI * 2, true); ctx.arc(200, 80, 20, 0, Math.PI * 2, true); ctx.fill('evenodd');
  ctx.globalCompositeOperation = 'source-over';
  const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'red'); g.addColorStop(0.5, 'green'); g.addColorStop(1, 'blue');
  ctx.fillStyle = g; ctx.fillRect(0, h - 12, w, 12);
  ctx.shadowBlur = 8; ctx.shadowColor = 'black'; ctx.fillStyle = 'white'; ctx.font = '16px "Segoe UI"';
  ctx.fillText('AliasMode ☃ ∑ Ж 漢字 \u{1F98A}', 10, h - 20);
  ctx.shadowBlur = 0;
}

// Only solid axis-aligned rectangles: no anti-aliasing, no text.
function drawSimple(ctx) {
  ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 100, 50);
  ctx.fillStyle = '#ff0000'; ctx.fillRect(10, 10, 30, 30);
  ctx.fillStyle = '#00ff00'; ctx.fillRect(50, 10, 30, 30);
}

// Text only, several fonts, no other shapes.
function drawText(ctx) {
  ctx.fillStyle = '#000'; let y = 18;
  for (const f of ['Arial', 'Times New Roman', 'Segoe UI', 'Calibri', 'Courier New', 'system-ui']) {
    ctx.font = `16px "${f}"`; ctx.fillText('Hamburgefonstiv 0123 éß', 4, y); y += 20;
  }
}

// Noise-tolerant views of pixel data: what a site could hash if it expects small per-profile noise.
async function robust(data, w, h) {
  const q = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) q[i] = (data[i] + 8) >> 4;
  const mask = new Uint8Array(w * h); let ink = 0; let alphaSum = 0;
  for (let i = 0; i < w * h; i++) { mask[i] = data[i * 4 + 3] > 0 ? 1 : 0; ink += mask[i]; alphaSum += data[i * 4 + 3]; }
  return { q16: await sha(q), alphaMask: await sha(mask), ink, alphaSum };
}

// How far a canvas of known solid colors is from the exact colors.
function noiseStats(data, expected) {
  let changed = 0; let maxDelta = 0; let alphaChanged = 0;
  for (let i = 0; i < data.length; i += 4) {
    const e = expected(i / 4);
    let hit = false;
    for (let c = 0; c < 4; c++) { const d = Math.abs(data[i + c] - e[c]); if (d) { hit = true; maxDelta = Math.max(maxDelta, d); if (c === 3) alphaChanged++; } }
    if (hit) changed++;
  }
  return { changed, maxDelta, alphaChanged, total: data.length / 4 };
}

const GL_VS ='attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const GL_FS = 'precision highp float; varying vec2 v; void main(){ float a = sin(v.x * 12.9898 + v.y * 78.233) * 43758.5453; gl_FragColor = vec4(fract(a), abs(v.x), abs(v.y) * 0.7 + 0.1 * cos(v.x * 40.0), 1.0); }';

function drawGL(gl) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, GL_VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, GL_FS));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.83, 0.77, -0.6, 0.13, 0.91, -0.5, 0.7, 0.95, 0.1, -0.2, -0.95]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

const GL_PARAM_RE = /^(MAX_|MIN_|ALIASED_|SUBPIXEL_BITS|RED_BITS|GREEN_BITS|BLUE_BITS|ALPHA_BITS|DEPTH_BITS|STENCIL_BITS|SAMPLES$|SAMPLE_BUFFERS|IMPLEMENTATION_COLOR_READ|VERSION|VENDOR|RENDERER|SHADING_LANGUAGE_VERSION|UNIFORM_BUFFER_OFFSET_ALIGNMENT)/;

async function glInfo(gl, prefix, out, canvas) {
  const params = {};
  const proto = Object.getPrototypeOf(gl);
  for (const name of Object.getOwnPropertyNames(proto).sort()) {
    if (!/^[A-Z0-9_]+$/.test(name) || !GL_PARAM_RE.test(name)) continue;
    try { const v = gl.getParameter(gl[name]); if (v !== null && v !== undefined) params[name] = ArrayBuffer.isView(v) ? Array.from(v) : v; } catch {}
  }
  while (gl.getError() !== gl.NO_ERROR) {}
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  out[prefix + '.unmaskedVendor'] = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
  out[prefix + '.unmaskedRenderer'] = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  out[prefix + '.vendor'] = params.VENDOR; out[prefix + '.renderer'] = params.RENDERER;
  out[prefix + '.version'] = params.VERSION; out[prefix + '.glsl'] = params.SHADING_LANGUAGE_VERSION;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) params.MAX_TEXTURE_MAX_ANISOTROPY_EXT = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
  out[prefix + '.params'] = params;
  out[prefix + '.paramsHash'] = await sha(JSON.stringify(params));
  const prec = {};
  for (const st of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) for (const pt of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) {
    const f = gl.getShaderPrecisionFormat(gl[st], gl[pt]); prec[st[0] + ':' + pt] = f ? [f.rangeMin, f.rangeMax, f.precision] : null;
  }
  out[prefix + '.shaderPrecisionHash'] = await sha(JSON.stringify(prec));
  out[prefix + '.shaderPrecision'] = prec;
  const ext = (gl.getSupportedExtensions() || []).slice().sort();
  out[prefix + '.extensions'] = ext;
  out[prefix + '.extensionsHash'] = await sha(ext.join(','));
  out[prefix + '.contextAttributes'] = gl.getContextAttributes();
  const px = drawGL(gl);
  out[prefix + '.readPixels'] = await sha(px);
  out[prefix + '.readPixelsRobust'] = await robust(px, gl.drawingBufferWidth, gl.drawingBufferHeight);
  const px2 = drawGL(gl);
  out[prefix + '.readPixelsRepeatSame'] = (await sha(px2)) === out[prefix + '.readPixels'];
  if (canvas && canvas.toDataURL) out[prefix + '.toDataURL'] = await sha(canvas.toDataURL());
  if (canvas && canvas.convertToBlob) out[prefix + '.convertToBlob'] = await sha(await (await canvas.convertToBlob()).arrayBuffer());
}

async function offscreen2d(out, prefix) {
  const oc = new OffscreenCanvas(300, 150);
  const ctx = oc.getContext('2d');
  drawScene(ctx, 300, 150);
  out[prefix + '.getImageData'] = await sha(ctx.getImageData(0, 0, 300, 150).data);
  out[prefix + '.convertToBlob'] = await sha(await (await oc.convertToBlob()).arrayBuffer());
  const t = new OffscreenCanvas(240, 140); const tc = t.getContext('2d'); drawText(tc);
  out[prefix + '.textOnly'] = await sha(tc.getImageData(0, 0, 240, 140).data);
  const m = {};
  for (const f of ['Arial', 'Times New Roman', 'Segoe UI', 'Courier New', 'system-ui']) {
    ctx.font = `16px "${f}"`; const r = ctx.measureText('Cwm fjordbank glyphs \u{1F603}');
    m[f] = [r.width, r.actualBoundingBoxLeft, r.actualBoundingBoxRight, r.actualBoundingBoxAscent, r.actualBoundingBoxDescent, r.fontBoundingBoxAscent, r.fontBoundingBoxDescent];
  }
  out[prefix + '.measureText'] = await sha(JSON.stringify(m));
  out[prefix + '.measureTextArial'] = m.Arial;
}
