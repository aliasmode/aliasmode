'use strict';
importScripts('scene.js');
self.onmessage = async () => {
  const out = {};
  const step = async (name, fn) => { try { await withTimeout(fn(), 15000, name); } catch (e) { out[name + '.error'] = String(e && e.message || e); } };
  await step('w.canvas', () => offscreen2d(out, 'w.canvas'));
  await step('w.webgl', async () => {
    const oc = new OffscreenCanvas(256, 128);
    const gl = oc.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) { out['w.webgl'] = 'none'; return; }
    const tmp = {}; await glInfo(gl, 'w.webgl', tmp, oc);
    for (const k of ['w.webgl.unmaskedVendor', 'w.webgl.unmaskedRenderer', 'w.webgl.readPixels', 'w.webgl.convertToBlob', 'w.webgl.paramsHash', 'w.webgl.extensionsHash']) out[k] = tmp[k];
  });
  await step('w.nav', async () => {
    out['w.nav.hardwareConcurrency'] = navigator.hardwareConcurrency;
    out['w.nav.deviceMemory'] = navigator.deviceMemory;
    out['w.nav.userAgent'] = navigator.userAgent;
    out['w.nav.platform'] = navigator.platform;
    out['w.nav.languages'] = navigator.languages;
    out['w.intl.timeZone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (navigator.userAgentData) out['w.uad.highEntropy'] = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64', 'formFactors']);
    if (navigator.gpu) {
      const a = await withTimeout(navigator.gpu.requestAdapter(), 8000, 'w.webgpu');
      out['w.webgpu.info'] = a ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : null;
    }
  });
  self.postMessage(out);
};
