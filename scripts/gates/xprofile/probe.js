'use strict';
const RUN = new URLSearchParams(location.search).get('run') || 'x';
const out = { run: RUN };
const step = async (name, fn, ms = 15000) => {
  try { await withTimeout(fn(), ms, name); } catch (e) { out[name + '.error'] = String(e && e.message || e); }
};

const FONTS = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Cascadia Code', 'Cascadia Mono',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia',
  'HoloLens MDL2 Assets', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
  'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MS PGothic', 'MS UI Gothic',
  'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe Fluent Icons', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script',
  'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'Segoe UI Variable', 'SimSun', 'SimSun-ExtB', 'Sitka', 'Sylfaen',
  'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic', 'Yu Gothic UI',
  'Agency FB', 'Algerian', 'Bodoni MT', 'Book Antiqua', 'Bookman Old Style', 'Calisto MT', 'Castellar', 'Century', 'Century Gothic',
  'Copperplate Gothic', 'Elephant', 'Footlight MT Light', 'Garamond', 'Gill Sans MT', 'Haettenschweiler', 'Lucida Bright', 'Lucida Fax',
  'Lucida Handwriting', 'Magneto', 'Monotype Corsiva', 'MS Outlook', 'MS Reference Sans Serif', 'MT Extra', 'Papyrus', 'Perpetua',
  'Rockwell', 'Showcard Gothic', 'Tw Cen MT', 'Wide Latin', 'Aptos', 'Grandview', 'Seaford', 'Skeena', 'Tenorite', 'Bierstadt',
  'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'Geneva', 'Lucida Grande', 'Avenir', 'Avenir Next', 'Futura', 'Optima', 'Gill Sans',
  'Baskerville', 'Didot', 'American Typewriter', 'Apple Color Emoji', 'PingFang SC', 'Hiragino Sans', 'SF Pro', 'Chalkboard',
  'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif', 'Ubuntu', 'Noto Sans', 'Noto Color Emoji', 'Cantarell', 'Droid Sans',
  'Roboto', 'Open Sans', 'Lato', 'Source Sans Pro', 'Fira Sans', 'Inter', 'Montserrat', 'Adobe Caslon Pro', 'Myriad Pro', 'Minion Pro',
  'Batang', 'Gulim', 'Meiryo', 'Meiryo UI', 'MS Mincho', 'NSimSun', 'KaiTi', 'FangSong', 'SimHei', 'DengXian', 'Leelawadee', 'Aharoni',
  'David', 'Miriam', 'Arabic Typesetting', 'Simplified Arabic', 'Traditional Arabic', 'Andalus', 'Iskoola Pota', 'Kartika', 'Latha',
  'Mangal', 'Raavi', 'Shruti', 'Tunga', 'Vrinda', 'Gautami', 'Kalinga', 'Shonar Bangla', 'Vani', 'Utsaah', 'Euphemia', 'Plantagenet Cherokee',
  'Estrangelo Edessa', 'Lao UI', 'Khmer UI', 'DokChampa', 'Daunpenh', 'Microsoft Uighur', 'Urdu Typesetting', 'Calibri Light', 'Segoe UI Light',
  'Segoe UI Semibold', 'Arial Unicode MS', 'Lucida Sans', 'Franklin Gothic Book', 'Small Fonts', 'Terminal', 'Modern', 'Roman', 'Script', 'Fixedsys', 'System',
];

function fontDetect() {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
  document.body.appendChild(holder);
  const bases = ['monospace', 'sans-serif', 'serif'];
  const mk = family => { const s = document.createElement('span'); s.style.cssText = 'font-size:72px;white-space:nowrap'; s.style.fontFamily = family; s.textContent = 'mmmmmmmmmmlliWW@#0'; holder.appendChild(s); return s; };
  const base = {}; for (const b of bases) { const s = mk(b); base[b] = [s.offsetWidth, s.offsetHeight]; }
  const found = []; const widths = {};
  for (const f of FONTS) {
    let hit = false; const w = [];
    for (const b of bases) { const s = mk(`"${f}", ${b}`); w.push(s.offsetWidth, s.offsetHeight); if (s.offsetWidth !== base[b][0] || s.offsetHeight !== base[b][1]) hit = true; }
    if (hit) { found.push(f); widths[f] = w; }
  }
  holder.remove();
  return { found, widths, base };
}

async function localFontFaces() {
  const res = {};
  for (const f of ['Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Bahnschrift', 'Cascadia Code', 'Aptos', 'Sitka', 'Segoe UI Variable', 'Segoe Fluent Icons', 'Ink Free', 'Gabriola', 'Helvetica', 'Menlo', 'DejaVu Sans', 'MS Gothic', 'SimSun', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', 'Nirmala UI', 'Leelawadee UI', 'Javanese Text', 'Myanmar Text']) {
    try { const ff = new FontFace('probe-' + f.replace(/\W/g, ''), `local("${f}")`); await withTimeout(ff.load(), 3000, 'ff'); res[f] = true; } catch { res[f] = false; }
  }
  return res;
}

function textRects() {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:3px;top:3px;';
  document.body.appendChild(holder);
  const strings = ['Cwm fjordbank glyphs vext quiz', '\u{1F603}\u{1F98A}\u{1F44D}\u{1F3FD}\u{1F1FA}\u{1F1F8}\u{1F468}‍\u{1F469}‍\u{1F467}', '漢字かなカナ한국어', 'Ж∑Ω≈ç√∫ ﷺ अ ก'];
  const fonts = ['Arial', 'Times New Roman', 'Segoe UI', 'Calibri', 'Courier New', 'system-ui', 'sans-serif', 'serif', 'monospace', 'Segoe UI Emoji'];
  const r = {}; const off = {}; const rng = {};
  for (const f of fonts) for (const [i, s] of strings.entries()) {
    const sp = document.createElement('span'); sp.style.fontFamily = `"${f}"`; sp.style.fontSize = '17.3px'; sp.textContent = s; holder.appendChild(sp); holder.appendChild(document.createElement('br'));
    const b = sp.getBoundingClientRect(); r[f + '|' + i] = [b.width, b.height];
    off[f + '|' + i] = [sp.offsetWidth, sp.offsetHeight];
    const range = document.createRange(); range.selectNodeContents(sp); rng[f + '|' + i] = Array.from(range.getClientRects(), q => [q.width, q.height]);
  }
  const emoji = document.createElement('span'); emoji.style.fontSize = '40px'; emoji.textContent = '\u{1F600}'; holder.appendChild(emoji);
  const em = [emoji.getBoundingClientRect().width, emoji.getBoundingClientRect().height];
  holder.remove();
  return { r, off, rng, em };
}

function svgText() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '600'); svg.setAttribute('height', '200');
  document.body.appendChild(svg);
  const res = {};
  for (const f of ['Arial', 'Times New Roman', 'Segoe UI', 'Courier New', 'system-ui']) {
    const t = document.createElementNS(ns, 'text'); t.setAttribute('x', '5'); t.setAttribute('y', '50'); t.setAttribute('font-family', f); t.setAttribute('font-size', '23.7');
    t.textContent = 'Cwm fjordbank glyphs \u{1F603} 漢字'; svg.appendChild(t);
    const b = t.getBBox(); res[f] = [b.x, b.y, b.width, b.height, t.getComputedTextLength(), t.getSubStringLength(0, 5)];
  }
  svg.remove();
  return res;
}

function measureAll() {
  const c = document.createElement('canvas').getContext('2d'); const m = {};
  for (const f of ['Arial', 'Times New Roman', 'Segoe UI', 'Calibri', 'Courier New', 'system-ui', 'sans-serif', 'serif', 'monospace', 'Segoe UI Emoji']) {
    for (const s of ['Cwm fjordbank glyphs vext quiz', '\u{1F603}\u{1F98A}\u{1F44D}\u{1F3FD}', '漢字かなカナ', 'Ж∑Ω≈ç√∫']) {
      c.font = `16px "${f}"`; const r = c.measureText(s);
      m[f + '|' + s.slice(0, 4)] = [r.width, r.actualBoundingBoxLeft, r.actualBoundingBoxRight, r.actualBoundingBoxAscent, r.actualBoundingBoxDescent, r.fontBoundingBoxAscent, r.fontBoundingBoxDescent];
    }
  }
  return m;
}

function blobOf(canvas) { return new Promise(res => canvas.toBlob(b => res(b))); }

async function audio() {
  const ctx = new OfflineAudioContext(1, 5000, 44100);
  const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12; comp.attack.value = 0; comp.release.value = 0.25;
  osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
  const buf = await ctx.startRendering(); const data = buf.getChannelData(0);
  let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
  out['audio.offlineSum'] = sum;
  out['audio.offlineHash'] = await sha(data);
  // Analyser node on an offline graph, read at a fixed time.
  const a = new OfflineAudioContext(1, 44100, 44100);
  const o2 = a.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 1234;
  const g = a.createBiquadFilter(); g.type = 'lowpass'; g.frequency.value = 3000;
  const an = a.createAnalyser(); an.fftSize = 2048;
  o2.connect(g); g.connect(an); an.connect(a.destination); o2.start(0);
  const freq = new Float32Array(an.frequencyBinCount); const time = new Float32Array(an.fftSize);
  // Firefox's OfflineAudioContext has no suspend(): there the analyser is read after rendering ends.
  const read = () => { an.getFloatFrequencyData(freq); an.getFloatTimeDomainData(time); };
  if (typeof a.suspend === 'function') a.suspend(0.5).then(() => { read(); a.resume(); });
  const b2 = await a.startRendering();
  if (typeof a.suspend !== 'function') read();
  out['audio.analyserFreq'] = await sha(freq);
  out['audio.analyserTime'] = await sha(time);
  out['audio.biquadHash'] = await sha(b2.getChannelData(0));
  try {
    const rt = new AudioContext();
    out['audio.ctx'] = { sampleRate: rt.sampleRate, baseLatency: rt.baseLatency, outputLatency: rt.outputLatency, maxChannelCount: rt.destination.maxChannelCount, state: rt.state, sinkId: rt.sinkId };
    await rt.close();
  } catch (e) { out['audio.ctx'] = 'error ' + e.message; }
}

async function voices() {
  let v = speechSynthesis.getVoices();
  if (!v.length) await new Promise(res => { speechSynthesis.onvoiceschanged = res; setTimeout(res, 4000); });
  v = speechSynthesis.getVoices();
  return v.map(x => [x.name, x.lang, x.localService, x.default, x.voiceURI].join('|'));
}

async function main() {
  const delay = Number(new URLSearchParams(location.search).get('delay') || 0);
  if (delay) await new Promise(r => setTimeout(r, delay));
  await step('canvas', async () => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 150;
    const ctx = c.getContext('2d'); drawScene(ctx, 300, 150);
    out['canvas.toDataURL'] = await sha(c.toDataURL());
    out['canvas.toDataURLRepeatSame'] = (await sha(c.toDataURL())) === out['canvas.toDataURL'];
    out['canvas.getImageData'] = await sha(ctx.getImageData(0, 0, 300, 150).data);
    out['canvas.getImageDataRepeatSame'] = (await sha(ctx.getImageData(0, 0, 300, 150).data)) === out['canvas.getImageData'];
    out['canvas.toBlob'] = await sha(await (await blobOf(c)).arrayBuffer());
    const s = document.createElement('canvas'); s.width = 100; s.height = 50; const sc = s.getContext('2d'); drawSimple(sc);
    out['canvas.simpleRects.getImageData'] = await sha(sc.getImageData(0, 0, 100, 50).data);
    out['canvas.simpleRects.toDataURL'] = await sha(s.toDataURL());
    const t = document.createElement('canvas'); t.width = 240; t.height = 140; const tc = t.getContext('2d'); drawText(tc);
    out['canvas.textOnly.getImageData'] = await sha(tc.getImageData(0, 0, 240, 140).data);
    const e = document.createElement('canvas'); e.width = 60; e.height = 60; const ec = e.getContext('2d'); ec.font = '40px sans-serif'; ec.fillText('\u{1F600}', 5, 45);
    out['canvas.emoji.getImageData'] = await sha(ec.getImageData(0, 0, 60, 60).data);
    out['canvas.scene.robust'] = await robust(ctx.getImageData(0, 0, 300, 150).data, 300, 150);
    out['canvas.textOnly.robust'] = await robust(tc.getImageData(0, 0, 240, 140).data, 240, 140);
    out['canvas.emoji.robust'] = await robust(ec.getImageData(0, 0, 60, 60).data, 60, 60);
    out['canvas.simpleRects.noise'] = noiseStats(sc.getImageData(0, 0, 100, 50).data, i => {
      const x = i % 100, y = Math.floor(i / 100);
      if (y >= 10 && y < 40 && x >= 10 && x < 40) return [255, 0, 0, 255];
      if (y >= 10 && y < 40 && x >= 50 && x < 80) return [0, 255, 0, 255];
      return [0x12, 0x34, 0x56, 255];
    });
    const tx = tc.getImageData(0, 0, 240, 140).data; let rgbInk = 0; for (let i = 0; i < tx.length; i += 4) if (tx[i] || tx[i + 1] || tx[i + 2]) rgbInk++;
    out['canvas.textOnly.nonBlackPixels'] = rgbInk;
  });
  await step('offscreenMain', () => offscreen2d(out, 'offscreen.main'));
  await step('worker', () => new Promise((res, rej) => {
    const w = new Worker('worker.js'); w.onmessage = ev => { Object.assign(out, ev.data); w.terminate(); res(); }; w.onerror = e => rej(new Error(e.message)); w.postMessage(1);
  }), 60000);
  await step('text', async () => {
    out['text.measureText'] = await sha(JSON.stringify(measureAll()));
    out['text.measureTextArial'] = measureAll()['Arial|Cwm '];
    const tr = textRects();
    out['text.domRect'] = await sha(JSON.stringify(tr.r));
    out['text.domRectArial'] = tr.r['Arial|0'];
    out['text.offsetWH'] = await sha(JSON.stringify(tr.off));
    out['text.rangeRects'] = await sha(JSON.stringify(tr.rng));
    out['text.emojiRect'] = tr.em;
    const sv = svgText(); out['svg.textMetrics'] = await sha(JSON.stringify(sv)); out['svg.Arial'] = sv.Arial;
  });
  await step('fonts', async () => {
    const f = fontDetect(); out['fonts.detected'] = f.found; out['fonts.count'] = f.found.length; out['fonts.hash'] = await sha(f.found.join(','));
    out['fonts.widthsHash'] = await sha(JSON.stringify(f.widths)); out['fonts.baseWidths'] = f.base;
    out['fonts.localFontFace'] = await localFontFaces();
  }, 60000);
  await step('webgl', async () => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const gl = c.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) { out['webgl'] = 'none'; return; }
    await glInfo(gl, 'webgl', out, c);
  });
  await step('webgl2', async () => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) { out['webgl2'] = 'none'; return; }
    await glInfo(gl, 'webgl2', out, c);
  });
  await step('webgpu', async () => {
    if (!navigator.gpu) { out['webgpu'] = 'no navigator.gpu'; return; }
    const a = await withTimeout(navigator.gpu.requestAdapter(), 10000, 'requestAdapter');
    if (!a) { out['webgpu'] = 'no adapter'; return; }
    out['webgpu.info'] = { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description, subgroupMin: a.info.subgroupMinSize, subgroupMax: a.info.subgroupMaxSize, isFallback: a.info.isFallbackAdapter };
    out['webgpu.features'] = Array.from(a.features).sort();
    const lim = {}; for (const k in a.limits) lim[k] = a.limits[k]; out['webgpu.limits'] = lim; out['webgpu.limitsHash'] = await sha(JSON.stringify(lim));
    out['webgpu.preferredFormat'] = navigator.gpu.getPreferredCanvasFormat();
    out['webgpu.wgslFeatures'] = Array.from(navigator.gpu.wgslLanguageFeatures || []).sort();
  }, 20000);
  await step('audio', audio, 20000);
  await step('voices', async () => { const v = await voices(); out['speech.voices'] = v; out['speech.voicesHash'] = await sha(v.join(';')); });
  await step('media', async () => {
    const d = await navigator.mediaDevices.enumerateDevices();
    out['media.devices'] = d.map(x => [x.kind, x.deviceId, x.groupId, x.label].join('|'));
    const can = {}; const v = document.createElement('video'); const au = document.createElement('audio');
    for (const t of ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"', 'video/ogg; codecs="theora"', 'video/mp4; codecs="dvh1.05.06"']) can[t] = [v.canPlayType(t), MediaSource.isTypeSupported(t)];
    for (const t of ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'audio/ogg; codecs="opus"', 'audio/flac', 'audio/wav', 'audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ec-3"']) can[t] = [au.canPlayType(t), MediaSource.isTypeSupported(t)];
    out['media.canPlay'] = can;
    const mc = {};
    for (const [name, ct] of [['h264', 'video/mp4; codecs="avc1.640028"'], ['hevc', 'video/mp4; codecs="hvc1.1.6.L120.90"'], ['vp9', 'video/webm; codecs="vp09.00.40.08"'], ['av1', 'video/mp4; codecs="av01.0.08M.08"']]) {
      try { const r = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: ct, width: 1920, height: 1080, bitrate: 5000000, framerate: 30 } }); mc[name] = [r.supported, r.smooth, r.powerEfficient]; } catch (e) { mc[name] = 'err'; }
    }
    out['media.decodingInfo'] = mc;
    try { const vc = RTCRtpSender.getCapabilities('video'); const ac = RTCRtpSender.getCapabilities('audio'); out['webrtc.codecsHash'] = await sha(JSON.stringify([vc, ac])); out['webrtc.videoCodecCount'] = vc.codecs.length; } catch (e) { out['webrtc.codecs'] = 'err ' + e.message; }
  });
  await step('navigator', async () => {
    const n = navigator;
    Object.assign(out, {
      'nav.userAgent': n.userAgent, 'nav.appVersion': n.appVersion, 'nav.platform': n.platform, 'nav.vendor': n.vendor,
      'nav.hardwareConcurrency': n.hardwareConcurrency, 'nav.deviceMemory': n.deviceMemory, 'nav.languages': n.languages,
      'nav.maxTouchPoints': n.maxTouchPoints, 'nav.pdfViewerEnabled': n.pdfViewerEnabled, 'nav.webdriver': n.webdriver, 'nav.doNotTrack': n.doNotTrack,
      'nav.plugins': Array.from(n.plugins, p => p.name), 'nav.mimeTypes': Array.from(n.mimeTypes, m => m.type),
      'nav.connection': n.connection ? { type: n.connection.effectiveType, rtt: n.connection.rtt, downlink: n.connection.downlink, saveData: n.connection.saveData } : null,
      'nav.globalPrivacyControl': n.globalPrivacyControl,
    });
    if (n.userAgentData) {
      out['uad.lowEntropy'] = { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform };
      out['uad.highEntropy'] = await n.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64', 'formFactors']);
    }
    try { const e = await n.storage.estimate(); out['storage.quota'] = e.quota; } catch (e) { out['storage.quota'] = 'err'; }
    out['perf.jsHeapSizeLimit'] = performance.memory ? performance.memory.jsHeapSizeLimit : null;
    try { const b = await withTimeout(n.getBattery(), 3000, 'battery'); out['battery'] = { charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime }; } catch (e) { out['battery'] = 'err ' + e.message; }
    try { const m = await withTimeout(n.keyboard.getLayoutMap(), 3000, 'kbd'); const ent = Array.from(m.entries()).sort(); out['keyboard.layoutHash'] = await sha(JSON.stringify(ent)); out['keyboard.KeyQ'] = m.get('KeyQ'); } catch (e) { out['keyboard'] = 'err ' + e.message; }
    const perms = {};
    for (const p of ['notifications', 'geolocation', 'camera', 'microphone', 'midi', 'clipboard-read', 'persistent-storage', 'window-management', 'local-fonts', 'background-sync']) {
      try { perms[p] = (await n.permissions.query({ name: p })).state; } catch { perms[p] = 'n/a'; }
    }
    out['permissions'] = perms;
    out['nav.notificationPermission'] = typeof Notification !== 'undefined' ? Notification.permission : null;
  });
  await step('screen', async () => {
    const s = screen;
    Object.assign(out, {
      'screen.size': [s.width, s.height, s.availWidth, s.availHeight, s.availLeft, s.availTop],
      'screen.depth': [s.colorDepth, s.pixelDepth], 'screen.orientation': s.orientation && s.orientation.type, 'screen.isExtended': s.isExtended,
      'window.dpr': devicePixelRatio, 'window.inner': [innerWidth, innerHeight], 'window.outer': [outerWidth, outerHeight], 'window.pos': [screenX, screenY],
      'window.scrollbar': (() => { const d = document.createElement('div'); d.style.cssText = 'width:100px;height:100px;overflow:scroll;position:absolute;top:-999px'; document.body.appendChild(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; })(),
    });
    const mq = {};
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(forced-colors: active)', '(color-gamut: p3)', '(color-gamut: srgb)', '(dynamic-range: high)', '(monochrome)', '(inverted-colors: inverted)', '(hover: hover)', '(pointer: fine)', '(any-pointer: coarse)', '(prefers-reduced-transparency: reduce)', '(update: fast)', '(device-width: 1920px)', '(scripting: enabled)']) mq[q] = matchMedia(q).matches;
    out['css.mediaQueries'] = mq;
  });
  await step('css', async () => {
    const d = document.createElement('div'); document.body.appendChild(d); const cs = {};
    for (const c of ['Canvas', 'CanvasText', 'ButtonFace', 'ButtonText', 'Highlight', 'HighlightText', 'GrayText', 'Field', 'LinkText', 'AccentColor', 'AccentColorText', 'Mark']) { d.style.color = c; cs[c] = getComputedStyle(d).color; }
    const fonts = {};
    for (const f of ['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']) { d.style.font = f; fonts[f] = getComputedStyle(d).fontFamily + ' ' + getComputedStyle(d).fontSize; }
    d.style.font = ''; d.style.fontFamily = 'system-ui'; fonts.systemUi = getComputedStyle(d).fontFamily;
    d.remove();
    out['css.systemColors'] = cs; out['css.systemFonts'] = fonts;
  });
  await step('math', async () => {
    const M = Math;
    out['math'] = [M.acos(0.123124234234234242), M.acosh(1e308), M.asin(0.123124234234234242), M.asinh(1), M.atanh(0.5), M.atan(0.5), M.sin(-1e300), M.sinh(1), M.cos(10.000000000123), M.cosh(1), M.tan(-1e300), M.tanh(1), M.exp(1), M.expm1(1), M.log1p(10), M.pow(Math.PI, -100), M.cbrt(100), M.log(1000)];
    out['math.hash'] = await sha(JSON.stringify(out['math']));
  });
  await step('intl', async () => {
    const ro = Intl.DateTimeFormat().resolvedOptions();
    Object.assign(out, {
      'intl.timeZone': ro.timeZone, 'intl.locale': ro.locale, 'intl.calendar': ro.calendar, 'intl.numberingSystem': ro.numberingSystem,
      'intl.tzOffset': new Date(2026, 0, 1).getTimezoneOffset() + '/' + new Date(2026, 6, 1).getTimezoneOffset(),
      'intl.number': new Intl.NumberFormat().format(1234567.891), 'intl.date': new Date(0).toString(),
      'intl.supportedTZCount': Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone').length : null,
    });
  });
  await step('globals', async () => {
    out['global.windowPropCount'] = Object.getOwnPropertyNames(window).length;
    out['global.chromeKeys'] = window.chrome ? Object.keys(window.chrome).sort() : null;
    out['global.documentTitle'] = document.title;
  });
  await step('headers', async () => {
    const r = await fetch('/hdr?run=' + RUN, { cache: 'no-store' }); out['headers.echo'] = await r.json();
  });
  await fetch('/result?run=' + RUN, { method: 'POST', body: JSON.stringify(out) });
  document.title = 'done ' + RUN;
}
main();
