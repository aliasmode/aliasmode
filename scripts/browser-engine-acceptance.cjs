'use strict';
// Browser-only acceptance on a disposable Windows runner. All origins and data are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = process.argv[2];
const runId = process.argv[3];
if (process.platform !== 'win32') throw new Error('Native Windows execution is required');
if (!root || !/^[a-z0-9-]+$/i.test(runId || '')) throw new Error('Expected root and fresh run ID');
const out = path.join(root, 'evidence', runId);
const profiles = path.join(root, 'profiles', runId);
fs.mkdirSync(out, {recursive: true});
fs.mkdirSync(profiles, {recursive: true});
const {chromium} = require(path.join(root, 'automation', 'node_modules', 'playwright-core'));
const engines = JSON.parse(fs.readFileSync(path.join(root, 'engines.json'), 'utf8').replace(/^﻿/, ''));
const rows = [], active = new Set(), servers = [], requests = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => String(error && (error.stack || error.message) || error);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function emit(id, engine, status, expected, observed, interpretation = '') {
  const row = {id, engine: engine ? engine.id : 'harness', releaseVersion: engine ? engine.releaseVersion : null,
    status, expected, observed, interpretation, timestamp: new Date().toISOString()};
  rows.push(row);
  fs.writeFileSync(path.join(out, id + '.json'), JSON.stringify(row, null, 2));
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(rows, null, 2));
  console.log(`[${status.toUpperCase()}] ${id}`);
}
async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
const fixture = http.createServer((req, res) => {
  requests.push({url: req.url, host: req.headers.host, headers: req.headers});
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model');
  if (req.url.startsWith('/headers')) {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Local Windows fixture</title><button id="click" data-count="0" onclick="this.dataset.count=Number(this.dataset.count)+1">Probe</button>' +
      (req.url.startsWith('/frame') ? '' : '<iframe src="/frame"></iframe>'));
  }
});
let origin;
const common = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--window-size=1280,800'];
const seeded = (engine, seed) => engine.id === 'stock155' ? [] : [`--fingerprint=${seed}`, '--fingerprint-platform=windows', '--fingerprint-locale=en-US', '--fingerprint-timezone=Etc/UTC'];
async function launch(engine, label, extra = [], profilePath, httpCredentials, headed = false) {
  const profile = profilePath || path.join(profiles, label);
  fs.mkdirSync(profile, {recursive: true});
  const activePort = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(activePort)) fs.unlinkSync(activePort);
  const exe = path.join(root, 'browsers', engine.id, ...engine.binaryRelativePath.split('/'));
  if (digest(exe) !== engine.exeSha256) throw new Error('Executable hash mismatch: ' + engine.id);
  const flags = [...common, ...(headed ? [] : ['--headless=new']), `--user-data-dir=${profile}`, ...extra];
  const stdoutPath = path.join(out, label + '.stdout.log'), stderrPath = path.join(out, label + '.stderr.log');
  const stdout = fs.openSync(stdoutPath, 'w'), stderr = fs.openSync(stderrPath, 'w');
  const started = Date.now();
  let proc;
  try { proc = cp.spawn(exe, flags, {cwd: root, stdio: ['ignore', stdout, stderr], windowsHide: !headed}); }
  catch (error) {
    const diagnostic = cp.spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'browser-engine-launch-diagnostic.ps1')], {input: JSON.stringify({executable: exe, root, flags}), encoding: 'utf8', timeout: 15000, windowsHide: true});
    error.launch = {executable: exe, flags, nodeError: {code: error.code, errno: error.errno, syscall: error.syscall}, nativeDiagnostic: diagnostic.stdout, diagnosticError: diagnostic.error?.message || diagnostic.stderr};
    throw error;
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  const item = {engine, label, exe, profile, flags, proc, stdoutPath, stderrPath, started, stopped: false};
  active.add(item);
  proc.on('error', error => { item.spawnError = errorText(error); });
  proc.on('exit', (code, signal) => { item.exit = {code, signal, timestamp: new Date().toISOString()}; });
  while (Date.now() - started < 60000) {
    if (item.spawnError || item.exit) break;
    if (fs.existsSync(activePort)) {
      const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
      if (/^\d+$/.test(lines[0]) && lines[1]?.startsWith('/devtools/browser/')) {
        item.endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`; break;
      }
    }
    await pause(200);
  }
  try {
    if (!item.endpoint) throw new Error(item.spawnError || 'No DevTools endpoint before process exit or startup deadline');
    item.browser = await chromium.connectOverCDP(item.endpoint, {timeout: 30000});
    item.session = await item.browser.newBrowserCDPSession();
    item.version = await item.session.send('Browser.getVersion');
    item.context = item.browser.contexts()[0];
    item.context.setDefaultTimeout(30000); item.context.setDefaultNavigationTimeout(30000);
    if (httpCredentials) await item.context.setHTTPCredentials(httpCredentials);
    item.page = await item.context.newPage();
    await item.page.goto(origin + '/fixture?case=' + encodeURIComponent(label), {waitUntil: 'domcontentloaded'});
    item.js = await item.page.evaluate(() => ({answer: 6 * 7, href: location.href, secureContext: isSecureContext}));
    item.startupMs = Date.now() - started;
    return item;
  } catch (error) {
    await stop(item); error.launch = launchFacts(item); throw error;
  }
}
function launchFacts(item) {
  return {executable: item.exe, executableSha256: digest(item.exe), expectedExecutableSha256: item.engine.exeSha256,
    flags: item.flags, profile: item.profile, browserVersion: item.version || null, js: item.js || null,
    startupMs: item.startupMs || Date.now() - item.started, pid: item.proc.pid || null,
    exit: item.exit || null, forcedStop: !!item.forcedStop,
    stderr: fs.existsSync(item.stderrPath) ? fs.readFileSync(item.stderrPath, 'utf8').slice(-10000) : ''};
}
async function stop(item) {
  if (!item || item.stopped) return;
  if (!item.exit && item.session) await bounded(item.session.send('Browser.close'), 10000, 'Browser.close').catch(() => {});
  const deadline = Date.now() + 15000;
  while (!item.exit && !item.spawnError && Date.now() < deadline) await pause(100);
  if (!item.exit && !item.spawnError) {
    item.forcedStop = true;
    cp.spawnSync('taskkill.exe', ['/PID', String(item.proc.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true, timeout: 10000});
    await pause(500);
  }
  if (item.browser) await bounded(item.browser.close(), 10000, 'CDP disconnect').catch(() => {});
  item.stopped = !!item.exit || !!item.spawnError;
  if (item.stopped) active.delete(item);
}
async function sandbox(item) {
  const id = item.label + '-sandbox';
  try {
    const info = await item.session.send('SystemInfo.getProcessInfo');
    const rendererPids = info.processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    if (!rendererPids.length) throw new Error('No renderer PID was reported');
    const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'browser-engine-sandbox.ps1'), '-ProcessIds', rendererPids.join(',')], {encoding: 'utf8', timeout: 30000, windowsHide: true});
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Token inspection did not finish');
    const tokens = JSON.parse(result.stdout.trim().replace(/^﻿/, ''));
    const measured = tokens.length === rendererPids.length && tokens.every(t => !t.error && Number.isInteger(t.integrityRid));
    const protectedRenderers = measured && tokens.every(t => t.integrityRid <= 4096 && t.inJob);
    emit(id, item.engine, !measured ? 'blocked' : protectedRenderers ? 'pass' : 'fail', 'Renderer tokens have low-or-untrusted integrity and belong to a Windows job', {tokens, rendererPids, flags: item.flags}, 'AppContainer is recorded, not required. Token checks do not certify every sandbox boundary or helper.');
  } catch (error) { emit(id, item.engine, 'blocked', 'Inspect native Windows renderer protection', {error: errorText(error)}); }
}
async function identityProbe() {
  const n = navigator;
  const r = {userAgent: n.userAgent, platform: n.platform, language: n.language, languages: [...n.languages],
    hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory, maxTouchPoints: n.maxTouchPoints,
    webdriver: n.webdriver, intl: Intl.DateTimeFormat().resolvedOptions(), timezoneOffset: new Date().getTimezoneOffset()};
  if (n.userAgentData) {
    r.userAgentData = n.userAgentData.toJSON();
    r.highEntropy = await n.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64']);
  }
  if (typeof screen !== 'undefined') r.screen = {width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, dpr: devicePixelRatio};
  return r;
}
async function renderingProbe() {
  const result = {};
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const different = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
  const makeCanvas = () => typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), {width: 16, height: 12}) : new OffscreenCanvas(16, 12);
  try {
    const c = makeCanvas(), ctx = c.getContext('2d'), image = ctx.createImageData(16, 12);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) image.data.set([(x * 17 + y * 7) % 256, (x * 11 + y * 19) % 256, (x * 31 + y * 3) % 256, 255], (y * 16 + x) * 4);
    ctx.putImageData(image, 0, 0);
    const full = ctx.getImageData(0, 0, 16, 12).data, repeat = ctx.getImageData(0, 0, 16, 12).data, small = new Uint8ClampedArray(full.length);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) small.set(ctx.getImageData(x, y, 1, 1).data, (y * 16 + x) * 4);
    const copied = makeCanvas().getContext('2d'); copied.drawImage(c, 0, 0);
    const copiedBytes = copied.getImageData(0, 0, 16, 12).data;
    result.canvas = {available: true, hash: await hash(full), repeatHash: await hash(repeat), singletonHash: await hash(small), copyHash: await hash(copiedBytes), repeatDifferences: different(full, repeat), singletonDifferences: different(full, small), copyDifferences: different(full, copiedBytes)};
  } catch (error) { result.canvas = {available: false, error: String(error)}; }
  try {
    const gl = makeCanvas().getContext('webgl2');
    if (!gl) result.webgl2 = {available: false, reason: 'getContext(webgl2) returned null'};
    else {
      const debug = gl.getExtension('WEBGL_debug_renderer_info'), extensions = gl.getSupportedExtensions(), norm = gl.getExtension('EXT_texture_norm16');
      const ext = {listed: extensions.includes('EXT_texture_norm16'), returned: !!norm};
      if (norm) {
        const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        ext.priorError = gl.getError(); gl.texStorage2D(gl.TEXTURE_2D, 1, norm.R16_EXT, 1, 1);
        ext.allocationError = gl.getError(); ext.contextLost = gl.isContextLost(); gl.deleteTexture(texture);
      }
      result.webgl2 = {available: true, renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, extensions, norm16: ext};
    }
  } catch (error) { result.webgl2 = {available: false, error: String(error)}; }
  try {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (!adapter) result.webgpu = {available: false, reason: 'WebGPU absent or requestAdapter returned null'};
    else {
      const info = adapter.info;
      result.webgpu = {available: true, info: {vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, subgroupMinSize: info.subgroupMinSize, subgroupMaxSize: info.subgroupMaxSize}, features: [...adapter.features]};
      try { const device = await adapter.requestDevice(); device.queue.submit([]); await device.queue.onSubmittedWorkDone(); result.webgpu.basicDevice = true; device.destroy(); }
      catch (error) { result.webgpu.basicDevice = false; result.webgpu.deviceError = String(error); }
    }
  } catch (error) { result.webgpu = {available: false, error: String(error)}; }
  if (typeof OfflineAudioContext === 'undefined') result.audio = {available: false, reason: 'OfflineAudioContext absent'};
  else try {
    const audioCase = async frequency => {
      const ctx = new OfflineAudioContext(1, 4096, 44100), osc = ctx.createOscillator(), compressor = ctx.createDynamicsCompressor();
      osc.type = 'triangle'; osc.frequency.value = frequency; compressor.threshold.value = -30; compressor.ratio.value = 8;
      osc.connect(compressor); compressor.connect(ctx.destination); osc.start();
      const buffer = await ctx.startRendering(), a = buffer.getChannelData(0), b = new Float32Array(a.length); buffer.copyFromChannel(b, 0);
      return {finite: a.every(Number.isFinite), nonzero: a.some(x => x !== 0), hash: await hash(a), copyDifferences: different(a, b)};
    };
    result.audio = {available: true, first: await audioCase(1000), repeat: await audioCase(1000), changedInput: await audioCase(1001)};
  } catch (error) { result.audio = {available: false, error: String(error)}; }
  return result;
}
function headerChecks(identity, headers) {
  const checks = [{key: 'user-agent', expected: identity.userAgent, actual: headers['user-agent']}];
  const add = (key, expected, decode = JSON.parse) => {
    if (headers[key] === undefined || expected === undefined) { checks.push({key, status: 'missing', expected, actual: headers[key]}); return; }
    try { const actual = decode(headers[key]); checks.push({key, expected, actual, equal: JSON.stringify(expected) === JSON.stringify(actual)}); }
    catch (error) { checks.push({key, actual: headers[key], equal: false, error: String(error)}); }
  };
  checks[0].equal = checks[0].expected === checks[0].actual;
  const sortBrands = values => values && [...values].sort((a, b) => a.brand.localeCompare(b.brand) || a.version.localeCompare(b.version));
  const brands = text => sortBrands([...text.matchAll(/"((?:[^"\\]|\\.)*)";v="([^"]+)"/g)].map(m => ({brand: JSON.parse('"' + m[1] + '"'), version: m[2]})));
  add('sec-ch-ua-platform', identity.userAgentData?.platform);
  add('sec-ch-ua', sortBrands(identity.userAgentData?.brands), brands);
  add('sec-ch-ua-full-version-list', sortBrands(identity.highEntropy?.fullVersionList), brands);
  for (const [header, field] of [['arch', 'architecture'], ['bitness', 'bitness'], ['model', 'model'], ['platform-version', 'platformVersion']]) add('sec-ch-ua-' + header, identity.highEntropy?.[field]);
  return checks;
}
async function capture(item) {
  const windowIdentity = await item.page.evaluate(identityProbe);
  const frame = item.page.frames().find(f => f !== item.page.mainFrame());
  const iframeIdentity = frame ? await frame.evaluate(identityProbe) : null;
  const headerPath = '/headers?case=' + encodeURIComponent(item.label);
  const echoedHeaders = await item.page.evaluate(async url => (await fetch(url)).json(), headerPath);
  const headers = requests.findLast(request => request.url === headerPath)?.headers;
  if (!headers) throw new Error('The fixture server did not observe the header request');
  const rendering = await item.page.evaluate(renderingProbe);
  const worker = await item.page.evaluate(async ({identitySource, renderingSource}) => {
    const source = `onmessage = async () => { try { postMessage({identity: await (${identitySource})(), rendering: await (${renderingSource})()}); } catch (e) { postMessage({error:String(e)}); } };`;
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'})), w = new Worker(url);
    try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Worker timeout')), 30000); w.onmessage = e => { clearTimeout(timer); resolve(e.data); }; w.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); }; w.postMessage('probe'); }); }
    finally { w.terminate(); URL.revokeObjectURL(url); }
  }, {identitySource: identityProbe.toString(), renderingSource: renderingProbe.toString()});
  const keys = ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'userAgentData', 'highEntropy', 'intl', 'timezoneOffset'];
  const consistency = keys.map(key => ({key, iframeEqual: !!iframeIdentity && JSON.stringify(windowIdentity[key]) === JSON.stringify(iframeIdentity[key]), workerEqual: !!worker.identity && JSON.stringify(windowIdentity[key]) === JSON.stringify(worker.identity[key])}));
  return {window: windowIdentity, iframe: iframeIdentity, worker, headers, echoedHeaders, echoMatchesServer: JSON.stringify(headers) === JSON.stringify(echoedHeaders), rendering, consistency, headerChecks: headerChecks(windowIdentity, headers)};
}
async function engineCase(engine, label, extra = []) {
  let item;
  try {
    item = await launch(engine, label, extra);
    await item.page.click('#click');
    const clicks = await item.page.getAttribute('#click', 'data-count');
    const expectedVersion = item.version.product.split('/').at(-1) === engine.browserVersion;
    emit(label + '-launch', engine, item.js.answer === 42 && clicks === '1' && expectedVersion ? 'pass' : 'fail', 'Pinned native browser version, CDP JavaScript and a Playwright click work', {...launchFacts(item), clicks});
    await sandbox(item);
    const data = await bounded(capture(item), 90000, 'Surface capture');
    emit(label + '-identity', engine, data.echoMatchesServer && data.consistency.every(x => x.iframeEqual && x.workerEqual) && data.headerChecks.every(x => x.equal !== false) ? 'pass' : 'fail', 'Shared identity fields agree across window/frame/worker and available HTTP client hints', data, 'Missing headers are recorded, not counted as matches. No UA, locale, timezone or viewport emulation is applied through CDP.');
    for (const [context, rendering] of [['window', data.rendering], ['worker', data.worker.rendering]]) {
      if (!rendering) { emit(label + '-' + context + '-rendering', engine, 'blocked', 'Collect rendering observations', data.worker); continue; }
      const canvas = rendering.canvas;
      emit(label + '-' + context + '-canvas', engine, !canvas.available ? 'unsupported' : !canvas.repeatDifferences && !canvas.singletonDifferences && !canvas.copyDifferences ? 'pass' : 'fail', 'Default-noise equivalent canvas read routes agree', canvas);
      for (const api of ['webgl2', 'webgpu']) emit(label + '-' + context + '-' + api, engine, !rendering[api].available ? 'unsupported' : rendering[api].basicDevice === false ? 'fail' : 'pass', 'Record default virtual GPU availability and basic device creation', rendering[api], 'Availability is not GPU conformance or physical-hardware validation.');
      const ext = rendering.webgl2.norm16;
      if (ext) emit(label + '-' + context + '-norm16', engine, !ext.returned ? 'unsupported' : ext.priorError || ext.contextLost ? 'blocked' : ext.allocationError ? 'fail' : 'pass', 'A returned EXT_texture_norm16 accepts valid one-pixel R16_EXT storage', ext);
    }
    const audio = data.rendering.audio;
    emit(label + '-audio', engine, !audio.available ? 'unsupported' : audio.first.finite && audio.first.nonzero && !audio.first.copyDifferences && audio.first.hash === audio.repeat.hash && audio.first.hash !== audio.changedInput.hash ? 'pass' : 'fail', 'Offline audio repeats, responds to changed input and agrees between read APIs', audio);
    await stop(item);
    emit(label + '-close', engine, !item.forcedStop && !!item.exit ? 'pass' : 'fail', 'Browser.close exits without forced termination', {exit: item.exit, forcedStop: !!item.forcedStop});
    return data;
  } catch (error) {
    await stop(item);
    emit(label + '-execution', engine, 'blocked', 'Complete native launch and surface capture', {error: errorText(error), launch: error.launch || (item && launchFacts(item))}, 'A collector error requires triage; it is not automatically an engine defect.');
    return null;
  }
}
async function writeStorage(page, token) {
  await page.evaluate(async token => {
    document.cookie = 'synthetic=' + token + '; Max-Age=3600; Path=/; SameSite=Lax'; localStorage.setItem('synthetic', token);
    await new Promise((resolve, reject) => { const r = indexedDB.open('synthetic-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(token, 'synthetic'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
  }, token);
}
async function readStorage(page) {
  return page.evaluate(async () => ({cookie: document.cookie, localStorage: localStorage.getItem('synthetic'), indexedDB: await new Promise((resolve, reject) => { const r = indexedDB.open('synthetic-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result, get = db.transaction('kv').objectStore('kv').get('synthetic'); get.onsuccess = () => { db.close(); resolve(get.result ?? null); }; get.onerror = () => reject(get.error); }; })}));
}
async function persistence(engine) {
  let a, b;
  const prefix = engine.id + '-persistent';
  try {
    const profileA = path.join(profiles, prefix + '-a'), profileB = path.join(profiles, prefix + '-b');
    a = await launch(engine, prefix + '-a-first', seeded(engine, 42), profileA);
    b = await launch(engine, prefix + '-b-first', seeded(engine, 43), profileB);
    await writeStorage(a.page, 'alpha'); const emptyB = await readStorage(b.page); await writeStorage(b.page, 'beta');
    const firstA = await readStorage(a.page), firstB = await readStorage(b.page);
    const isolated = emptyB.localStorage === null && emptyB.indexedDB === null && !emptyB.cookie.includes('synthetic=') && firstA.localStorage === 'alpha' && firstA.indexedDB === 'alpha' && firstA.cookie.includes('synthetic=alpha') && firstB.localStorage === 'beta' && firstB.indexedDB === 'beta' && firstB.cookie.includes('synthetic=beta');
    emit(prefix + '-isolation', engine, isolated ? 'pass' : 'fail', 'Concurrent profiles isolate cookies, localStorage and IndexedDB', {emptyB, firstA, firstB});
    await stop(a); await stop(b);
    a = await launch(engine, prefix + '-a-reopen', seeded(engine, 42), profileA);
    b = await launch(engine, prefix + '-b-reopen', seeded(engine, 43), profileB);
    const reopenedA = await readStorage(a.page), reopenedB = await readStorage(b.page);
    emit(prefix + '-reopen', engine, JSON.stringify(reopenedA) === JSON.stringify(firstA) && JSON.stringify(reopenedB) === JSON.stringify(firstB) ? 'pass' : 'fail', 'Both independent stores survive close/reopen', {firstA, firstB, reopenedA, reopenedB}, 'No existing profile migration or real account login is tested.');
    await a.page.evaluate(() => { window.syntheticReconnect = 'still-here'; });
    await a.browser.close(); a.browser = null; a.session = null;
    const aliveAfterDetach = !a.exit;
    a.browser = await chromium.connectOverCDP(a.endpoint, {timeout: 30000}); a.session = await a.browser.newBrowserCDPSession();
    const page = a.browser.contexts()[0].pages().find(p => p.url().includes('/fixture?case=' + prefix + '-a-reopen'));
    const token = page ? await page.evaluate(() => window.syntheticReconnect) : null;
    emit(prefix + '-cdp-reconnect', engine, aliveAfterDetach && token === 'still-here' ? 'pass' : 'fail', 'Detach and reconnect to the same live browser/page', {aliveAfterDetach, token});
  } catch (error) { emit(prefix + '-execution', engine, 'blocked', 'Complete storage and reconnect checks', {error: errorText(error), launch: error.launch}); }
  finally { await stop(a); await stop(b); }
}
async function proxyCase(engine) {
  let item;
  const proxyRequests = [], directHits = [], label = engine.id + '-proxy';
  const target = http.createServer((req, res) => { directHits.push({url: req.url, host: req.headers.host}); res.end('DIRECT-PATH'); });
  const targetPort = await listen(target);
  const authValue = 'Basic ' + Buffer.from('synthetic-user:synthetic-password').toString('base64');
  const proxy = http.createServer((req, res) => {
    const authenticated = req.headers['proxy-authorization'] === authValue;
    proxyRequests.push({url: req.url, authenticated});
    if (!authenticated) { res.writeHead(407, {'Proxy-Authenticate': 'Basic realm="local-fixture"'}); res.end('Authentication required'); }
    else { res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'}); res.end('<p id="proxy-proof">LOCAL-PROXY-PATH</p>'); }
  });
  const proxyPort = await listen(proxy);
  try {
    item = await launch(engine, label, [...seeded(engine, 42), `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP proxy-fixture.test 127.0.0.1'], undefined, {username: 'synthetic-user', password: 'synthetic-password'});
    await item.page.goto(`http://proxy-fixture.test:${targetPort}/auth`, {waitUntil: 'domcontentloaded'});
    const body = await item.page.textContent('body');
    emit(label + '-auth', engine, body.includes('LOCAL-PROXY-PATH') && proxyRequests.some(x => !x.authenticated) && proxyRequests.some(x => x.authenticated) && !directHits.length ? 'pass' : 'fail', '407 challenge leads to authenticated proxy routing, not direct traffic', {body, proxyRequests: [...proxyRequests], directHits: [...directHits]}, 'Local HTTP proxy with synthetic credentials via CDP; not HTTPS, SOCKS or production relay qualification.');
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    let navigationError = null;
    try { await item.page.goto(`http://proxy-fixture.test:${targetPort}/refusal`, {waitUntil: 'domcontentloaded', timeout: 15000}); } catch (error) { navigationError = String(error); }
    emit(label + '-refusal', engine, navigationError && !directHits.length ? 'pass' : 'fail', 'Stopped proxy produces an error without reaching a directly accessible loopback target', {navigationError, directHits}, 'External egress rules do not block the loopback direct-fallback path.');
  } catch (error) { emit(label + '-execution', engine, 'blocked', 'Complete authenticated HTTP proxy checks', {error: errorText(error), launch: error.launch, proxyRequests, directHits}); }
  finally { await stop(item); if (proxy.listening) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); } target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
}
function createExtension() {
  const directory = path.join(root, 'mv3-fixture'); fs.mkdirSync(directory);
  const {publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const key = publicKey.export({type: 'spki', format: 'der'});
  const id = crypto.createHash('sha256').update(key).digest().subarray(0, 16).toString('hex').replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x, 16)));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({manifest_version: 3, name: 'Local MV3 fixture', version: '1.0.0', key: key.toString('base64'), permissions: ['storage'], background: {service_worker: 'worker.js'}, content_scripts: [{matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle'}], web_accessible_resources: [{resources: ['page.html', 'page.js'], matches: ['http://127.0.0.1/*']}]}));
  fs.writeFileSync(path.join(directory, 'worker.js'), "chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.kind!=='probe')return;chrome.storage.local.get({count:0},v=>{const count=v.count+1;chrome.storage.local.set({count},()=>reply({value:42,count,id:chrome.runtime.id}));});return true;});");
  const message = "chrome.runtime.sendMessage({kind:'probe'},reply=>{document.documentElement.dataset.reply=JSON.stringify(reply||{error:chrome.runtime.lastError&&chrome.runtime.lastError.message});});";
  fs.writeFileSync(path.join(directory, 'content.js'), "document.documentElement.dataset.extensionId=chrome.runtime.id;" + message);
  fs.writeFileSync(path.join(directory, 'page.js'), message);
  fs.writeFileSync(path.join(directory, 'page.html'), '<!doctype html><title>Local MV3 resource</title><script src="page.js"></script>');
  return {directory, id};
}
async function extensionCase(engine, extension, headed = false, host = false) {
  let item;
  const label = `${engine.id}-mv3-${host ? 'host' : 'seed424242'}-${headed ? 'headed' : 'headless'}`;
  try {
    const flags = host ? ['--fingerprint=host'] : seeded(engine, 424242);
    item = await launch(engine, label, [...flags, `--disable-extensions-except=${extension.directory}`, `--load-extension=${extension.directory}`], undefined, undefined, headed);
    await item.page.waitForFunction(() => document.documentElement.dataset.reply, null, {timeout: 15000}).catch(() => {});
    const content = await item.page.evaluate(() => ({id: document.documentElement.dataset.extensionId || null, reply: JSON.parse(document.documentElement.dataset.reply || 'null')}));
    const targets = (await item.session.send('Target.getTargets')).targetInfos.filter(t => t.type === 'service_worker').map(t => ({type: t.type, url: t.url}));
    const resourceUrl = `chrome-extension://${extension.id}/page.html`;
    const resourceFetch = await item.page.evaluate(async url => { try { const response = await fetch(url); return {status: response.status}; } catch (error) { return {error: String(error)}; } }, resourceUrl);
    let resource = null;
    const resourcePage = await item.context.newPage();
    try { await resourcePage.goto(resourceUrl, {waitUntil: 'domcontentloaded'}); await resourcePage.waitForFunction(() => document.documentElement.dataset.reply, null, {timeout: 15000}); resource = await resourcePage.evaluate(() => JSON.parse(document.documentElement.dataset.reply)); }
    catch (error) { resource = {error: String(error)}; }
    const passed = content.id === extension.id && content.reply?.value === 42 && content.reply.count === 1 && resourceFetch.status === 200 && resource?.value === 42 && resource.count === 2;
    emit(label, engine, passed ? 'pass' : 'fail', 'Identical MV3 fixture supports content/worker messaging, storage and web-accessible resource navigation', {content, resourceFetch, resource, targets, extensionId: extension.id, launch: launchFacts(item)}, 'No missing-worker-target inference is made; actual messages and resource operations determine the outcome.');
  } catch (error) { emit(label, engine, 'blocked', 'Launch native Windows MV3 fixture', {error: errorText(error), launch: error.launch}); }
  finally { await stop(item); }
}
(async () => {
  origin = 'http://127.0.0.1:' + await listen(fixture);
  emit('windows-harness', null, 'pass', 'Run authored fixture controller natively on Windows', {platform: process.platform, architecture: process.arch, nodeVersion: process.version, origin, runId, flags: common}, 'All test origins are loopback. No real accounts or existing browser profiles are used.');
  const extension = createExtension();
  for (const engine of engines) {
    // Obtain launch and extension answers before the longer surface/reopen probes.
    await extensionCase(engine, extension);
    await extensionCase(engine, extension, true);
    if (engine.id === 'apostate') await extensionCase(engine, extension, false, true);
    await engineCase(engine, engine.id + '-default');
    await persistence(engine);
    await proxyCase(engine);
  }
  const apostate = engines.find(e => e.id === 'apostate');
  const first = await engineCase(apostate, 'apostate-seed42', seeded(apostate, 42));
  await engineCase(apostate, 'apostate-seed43', seeded(apostate, 43));
  const repeat = await engineCase(apostate, 'apostate-seed42-repeat', seeded(apostate, 42));
  if (first && repeat) {
    const observed = {identityEqual: JSON.stringify(first.window) === JSON.stringify(repeat.window), canvasFirst: first.rendering.canvas.hash, canvasRepeat: repeat.rendering.canvas.hash, audioFirst: first.rendering.audio.first?.hash, audioRepeat: repeat.rendering.audio.first?.hash};
    emit('apostate-cold-repeat', apostate, !first.rendering.canvas.available || !repeat.rendering.canvas.available || !first.rendering.audio.available || !repeat.rendering.audio.available ? 'blocked' : observed.identityEqual && observed.canvasFirst === observed.canvasRepeat && observed.audioFirst === observed.audioRepeat ? 'pass' : 'fail', 'Explicit seed identity and rendering repeat across fresh cold launches', observed);
  } else emit('apostate-cold-repeat', apostate, 'not-run', 'Compare cold captures', {reason: 'A required capture did not complete'});
})().catch(error => emit('harness-fatal', null, 'blocked', 'Complete the comparison', {error: errorText(error)})).finally(async () => {
  for (const item of [...active]) await stop(item);
  for (const server of servers) if (server.listening) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out, 'http-requests.json'), JSON.stringify(requests, null, 2));
  emit('windows-cleanup', null, active.size === 0 && servers.every(server => !server.listening) ? 'pass' : 'fail', 'Stop owned browsers and fixture listeners', {activeBrowsers: active.size, listeningServers: servers.filter(server => server.listening).length});
  const counts = {};
  for (const row of rows) { counts[row.engine] ||= {}; counts[row.engine][row.status] = (counts[row.engine][row.status] || 0) + 1; }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({counts, source: process.env.GITHUB_SHA, runId}, null, 2));
  console.log(JSON.stringify({counts, runId}));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = ['## Native Windows browser comparison', '', '| Engine | Pass | Fail | Blocked | Unsupported | Not run |', '|---|---:|---:|---:|---:|---:|'];
    for (const [engine, values] of Object.entries(counts)) table.push(`| ${engine} | ${values.pass || 0} | ${values.fail || 0} | ${values.blocked || 0} | ${values.unsupported || 0} | ${values['not-run'] || 0} |`);
    table.push('', 'Counts describe individual probes, not detection scores. See JSON artifacts for exact configurations and limitations.');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n') + '\n');
  }
  process.exitCode = rows.some(row => row.status === 'fail' || row.status === 'blocked') ? 1 : 0;
});
