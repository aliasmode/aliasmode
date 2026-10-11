'use strict';
// Public bot-detector pages on a disposable Windows runner. Raw CDP only: pages are
// opened with Target.createTarget and read after the wait, with no Runtime.enable.
const fs = require('node:fs');
const path = require('node:path');
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
const engines = JSON.parse(fs.readFileSync(path.join(root, 'engines.json'), 'utf8').replace(/^﻿/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => String(error && (error.stack || error.message) || error);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
// The verified repair from run 38077390950: only the version assembly manifest the release omits.
const MANIFEST_XML = "<assembly\r\n  xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'>\r\n  <assemblyIdentity\r\n      name='155.0.8059.31'\r\n      version='155.0.8059.31'\r\n      type='win32'/>\r\n  <file name='chrome_elf.dll'/>\r\n</assembly>\r\n";
const MANIFEST_SHA256 = 'dfc0444aa477681e88b3ea34867d58673b6894ac12980f435c67c0ee9673b5ab';
const SITES = [
  {id: 'creepjs', url: 'https://abrahamjuliot.github.io/creepjs/', wait: 40000, verdict: /headless|stealth|lies|bot|trust|crowd|blocked/i},
  {id: 'sannysoft', url: 'https://bot.sannysoft.com/', wait: 25000, verdict: /webdriver|chrome|permissions|plugins|languages|webgl|broken|failed|missing/i},
  {id: 'browserscan', url: 'https://www.browserscan.net/bot-detection', wait: 35000, verdict: /normal|robot|bot|abnormal|webdriver|cdp|headless|automat|result/i},
  {id: 'botd', url: 'https://fingerprintjs.github.io/BotD/main/', wait: 25000, verdict: /bot|kind|detect/i},
  {id: 'deviceandbrowserinfo', url: 'https://deviceandbrowserinfo.com/are_you_a_bot', wait: 30000, verdict: /bot|human|cdp|automat|headless|inconsisten/i},
  {id: 'pixelscan', url: 'https://pixelscan.net/', wait: 45000, verdict: /consisten|automat|bot|mask|spoof|proxy|detected|fingerprint|timezone|language/i},
];
const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText || '').slice(0, 40000);
  const failedRows = [...document.querySelectorAll('tr')]
    .filter(tr => tr.querySelector('.failed, td.failed') || /\\bfailed\\b/i.test(tr.className))
    .map(tr => tr.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 60);
  return {title: document.title, href: location.href, readyState: document.readyState, text, failedRows,
    navigator: {userAgent: navigator.userAgent, webdriver: navigator.webdriver, platform: navigator.platform,
      languages: [...navigator.languages], hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}};
})()`;
function client(endpoint) {
  const ws = new WebSocket(endpoint);
  let next = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  };
  ws.onclose = () => { for (const {reject} of pending.values()) reject(new Error('CDP socket closed')); pending.clear(); };
  const open = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP socket error')); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
  return {open, send, close: () => ws.close()};
}
const seeded = engine => engine.id === 'stock155' ? [] : ['--fingerprint=42', '--fingerprint-platform=windows', '--fingerprint-locale=en-US', '--fingerprint-timezone=Etc/UTC'];
async function launch(engine) {
  const profile = path.join(profiles, engine.id);
  fs.mkdirSync(profile, {recursive: true});
  const exe = path.join(root, 'browsers', engine.id, ...engine.binaryRelativePath.split('/'));
  if (digest(exe) !== engine.exeSha256) throw new Error('Executable hash mismatch: ' + engine.id);
  const flags = ['--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--window-size=1280,800', `--user-data-dir=${profile}`, ...seeded(engine)];
  const stderrPath = path.join(out, engine.id + '.stderr.log');
  const stderr = fs.openSync(stderrPath, 'w');
  const proc = cp.spawn(exe, flags, {cwd: root, stdio: ['ignore', 'ignore', stderr], windowsHide: false});
  fs.closeSync(stderr);
  const item = {engine, exe, flags, proc, stderrPath};
  proc.on('exit', (code, signal) => { item.exit = {code, signal}; });
  const activePort = path.join(profile, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < 60000 && !item.exit) {
    try {
      const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
      if (/^\d+$/.test(lines[0]) && lines[1]?.startsWith('/devtools/browser/')) { item.endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`; break; }
    } catch (error) { if (error.code !== 'EBUSY' && error.code !== 'ENOENT') throw error; }
    await pause(200);
  }
  if (!item.endpoint) { await stop(item); throw new Error('No DevTools endpoint: ' + JSON.stringify(item.exit || null) + ' ' + fs.readFileSync(stderrPath, 'utf8').slice(-3000)); }
  item.cdp = client(item.endpoint);
  await bounded(item.cdp.open, 15000, 'CDP connect');
  item.version = await item.cdp.send('Browser.getVersion');
  return item;
}
async function stop(item) {
  if (!item) return;
  if (!item.exit && item.cdp) await bounded(item.cdp.send('Browser.close'), 10000, 'Browser.close').catch(() => {});
  const deadline = Date.now() + 15000;
  while (!item.exit && Date.now() < deadline) await pause(100);
  if (!item.exit) cp.spawnSync('taskkill.exe', ['/PID', String(item.proc.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true, timeout: 10000});
  item.cdp?.close();
}
async function visit(item, site) {
  const result = {engine: item.engine.id, site: site.id, url: site.url};
  let targetId;
  try {
    ({targetId} = await item.cdp.send('Target.createTarget', {url: site.url}));
    await item.cdp.send('Target.activateTarget', {targetId}).catch(() => {});
    await pause(site.wait);
    const {sessionId} = await item.cdp.send('Target.attachToTarget', {targetId, flatten: true});
    const evaluated = await bounded(item.cdp.send('Runtime.evaluate', {expression: EXTRACT, returnByValue: true}, sessionId), 20000, 'Read page');
    if (evaluated.exceptionDetails) throw new Error('Page read failed: ' + JSON.stringify(evaluated.exceptionDetails).slice(0, 500));
    Object.assign(result, evaluated.result.value);
    result.verdictLines = result.text.split(/\r?\n/).map(line => line.trim()).filter(line => line && line.length < 240 && site.verdict.test(line)).slice(0, 40);
    try {
      const metrics = await item.cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const size = metrics.cssContentSize || metrics.contentSize;
      const clip = {x: 0, y: 0, width: Math.max(1, Math.ceil(Math.min(size.width, 1600))), height: Math.max(1, Math.ceil(Math.min(size.height, 9000))), scale: 1};
      const shot = await bounded(item.cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true, clip}, sessionId), 30000, 'Screenshot');
      fs.writeFileSync(path.join(out, `${item.engine.id}-${site.id}.png`), Buffer.from(shot.data, 'base64'));
      result.screenshot = `${item.engine.id}-${site.id}.png`;
    } catch (error) { result.screenshotError = errorText(error); }
  } catch (error) { result.error = errorText(error); }
  finally { if (targetId) await item.cdp.send('Target.closeTarget', {targetId}).catch(() => {}); }
  fs.writeFileSync(path.join(out, `${item.engine.id}-${site.id}.json`), JSON.stringify(result, null, 2));
  console.log(`[${result.error ? 'ERROR' : 'READ'}] ${item.engine.id} ${site.id}${result.error ? ': ' + result.error.split('\n')[0] : ''}`);
  return result;
}
(async () => {
  const results = [], launches = [];
  for (const engine of engines) {
    const directory = path.dirname(path.join(root, 'browsers', engine.id, engine.binaryRelativePath));
    if (engine.id === 'apostate') {
      const manifest = path.join(directory, engine.browserVersion + '.manifest');
      if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, MANIFEST_XML, {flag: 'wx'});
      if (digest(manifest) !== MANIFEST_SHA256) throw new Error('Manifest repair hash mismatch');
    }
    // Same app-package read access for every engine, as in the acceptance run.
    cp.spawnSync('icacls.exe', [directory, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '*S-1-15-2-2:(OI)(CI)(RX)', '/T', '/Q'], {encoding: 'utf8', timeout: 60000, windowsHide: true});
    let item;
    try {
      item = await launch(engine);
      launches.push({engine: engine.id, version: item.version, flags: item.flags, manifestRepair: engine.id === 'apostate'});
      for (const site of SITES) results.push(await visit(item, site));
    } catch (error) {
      launches.push({engine: engine.id, error: errorText(error)});
      console.log(`[ERROR] ${engine.id} launch: ${errorText(error).split('\n')[0]}`);
    } finally { await stop(item); }
  }
  fs.writeFileSync(path.join(out, 'launches.json'), JSON.stringify(launches, null, 2));
  fs.writeFileSync(path.join(out, 'detectors.json'), JSON.stringify(results.map(({text, ...rest}) => rest), null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Public bot-detector comparison', '', 'Datacenter IP, no GPU. Verdict lines are raw page text; read the screenshots for context.', ''];
    for (const result of results) {
      lines.push(`### ${result.engine} / ${result.site}`, '');
      if (result.error) lines.push('Error: `' + result.error.split('\n')[0].replace(/`/g, "'") + '`', '');
      for (const row of result.failedRows || []) lines.push('- failed: ' + row.replace(/\|/g, '/'));
      for (const line of (result.verdictLines || []).slice(0, 25)) lines.push('- ' + line.replace(/\|/g, '/'));
      lines.push('');
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  process.exitCode = launches.some(launch => launch.error) ? 1 : 0;
})().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
