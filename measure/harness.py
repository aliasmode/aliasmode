"""Bucket harness: launch a browser per config with a fresh profile, load probe.html, collect the posted JSON."""
import http.server, json, os, shutil, signal, subprocess, sys, tempfile, threading, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WIN = os.name == 'nt'
results = {}
cv = threading.Condition()

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = (HERE / 'probe.html').read_bytes()
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(204); self.end_headers()
        with cv: results[(data['label'], data['rep'])] = data; cv.notify_all()

def kill(p):
    if WIN: subprocess.run(['taskkill', '/T', '/F', '/PID', str(p.pid)], capture_output=True)
    else:
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    p.wait()

def main():
    browser, exe, configs_path, out_path = sys.argv[1:5]
    reps = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    configs = json.loads(Path(configs_path).read_text())
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    scratch = Path(tempfile.mkdtemp(prefix='bk-', dir=os.environ.get('BK_SCRATCH')))
    rows = []
    for cfg in configs:
        for rep in range(reps):
            label = cfg['label']; key = (label, str(rep))
            prof = scratch / f'p{len(rows)}'; prof.mkdir()
            url = f'http://127.0.0.1:{port}/probe.html?label={label}&rep={rep}'
            if browser == 'chrome':
                args = [exe, f'--user-data-dir={prof}', '--no-first-run', '--no-default-browser-check', '--disable-sync',
                        '--disable-component-update', '--disable-background-networking', '--window-size=1280,800']
                if not cfg.get('headed'): args.append('--headless=new')
                if not WIN: args.append('--no-sandbox')
                args += cfg.get('args', []) + [url]
            else:
                prefs = {'browser.shell.checkDefaultBrowser': False, 'datareporting.policy.dataSubmissionEnabled': False,
                         'toolkit.telemetry.reportingpolicy.firstRun': False, 'browser.startup.homepage_override.mstone': 'ignore',
                         'app.update.disabledForTesting': True, 'browser.aboutwelcome.enabled': False, 'trailhead.firstrun.didSeeAboutWelcome': True}
                prefs.update(cfg.get('prefs', {}))
                (prof / 'user.js').write_text(''.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});\n' for k, v in prefs.items()))
                args = [exe, '-no-remote', '-profile', str(prof), '-width', '1280', '-height', '800']
                if not cfg.get('headed'): args.append('-headless')
                args += cfg.get('args', []) + [url]
            env = dict(os.environ); env.update(cfg.get('env', {}))
            kw = {'creationflags': 0x00004000} if WIN else {'start_new_session': True, 'preexec_fn': lambda: os.nice(10)}
            t0 = time.time()
            p = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
            with cv: cv.wait_for(lambda: key in results, timeout=cfg.get('timeout', 60))
            kill(p)
            r = results.get(key) or {'label': label, 'rep': str(rep), 'error': 'timeout'}
            r['config'] = {k: v for k, v in cfg.items() if k != 'label'}; r['secs'] = round(time.time() - t0, 1)
            rows.append(r); print(label, rep, r.get('fpjs.text'), r.get('text300'), r.get('error', ''), flush=True)
            time.sleep(1); shutil.rmtree(prof, ignore_errors=True)
    Path(out_path).write_text(json.dumps(rows, indent=1))
    shutil.rmtree(scratch, ignore_errors=True)
    srv.shutdown()

main()
