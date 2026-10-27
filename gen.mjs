#!/usr/bin/env node
// ChatGPT image gen over raw CDP. Zero deps (Node 22+ global WebSocket).
// Usage: gen.mjs --login
//        gen.mjs [--ref img]... [--out dir] [--keep] "prompt"
//        gen.mjs --library [n] [--conv id] [--out dir]
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 9334;
const HOME = join(homedir(), 'Library/Application Support/chatgpt-image');
const PROFILE = join(HOME, 'chrome-profile');
const TABS = join(HOME, 'tabs'); // targetId -> owning pid, so orphans from killed runs get closed
const LAST = join(HOME, 'last-run'); // mtime = when the last run finished; idle reaper keys off it
const IDLE = 10 * 60000; // quit headless Chrome after this long unused, so the CDP port isn't open all day
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const COMPOSER = '.ProseMirror[contenteditable]';
const ATTACHED = `document.querySelectorAll('form img[src^="data:"], form img[src^="blob:"]').length`;
const UPLOADING = `!!document.querySelector('[data-composer-attachments] [role=progressbar]')`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const login = flag('--login'), keep = flag('--keep'), library = flag('--library'), reap = flag('--reap');
let out = resolve('.'), refs = [], prompt = [], count = 4, conv = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i]);
  else if (args[i] === '--ref') refs.push(resolve(args[++i]));
  else if (args[i] === '--conv') conv = args[++i];
  else if (library && /^\d+$/.test(args[i])) count = +args[i];
  else if (!['--login', '--keep', '--library', '--reap'].includes(args[i])) prompt.push(args[i]);
}
prompt = prompt.join(' ').trim();
if (!login && !library && !reap && !prompt) {
  console.error('usage: gen.mjs --login | gen.mjs [--ref img] [--out dir] [--keep] "prompt" | gen.mjs --library [n] [--conv id] [--out dir]');
  process.exit(2);
}
for (const r of refs) if (!existsSync(r)) { console.error(`ref not found: ${r}`); process.exit(2); }

const http = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, init);
const up = () => http('/json/version').then(r => r.ok, () => false);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function ensureChrome(visible) {
  if (await up()) {
    if (!visible) return sweep();
    // Login needs a real window; close the headless one holding the profile.
    await quitChrome();
  }
  mkdirSync(PROFILE, { recursive: true });
  // Headless passes once the profile is signed in; UA swap hides "HeadlessChrome".
  const version = (await new Promise(r => execFile(CHROME, ['--version'], (_, o) => r(o)))).match(/[\d.]+/)[0];
  spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--window-size=1100,750',
    ...(visible ? ['--window-position=80,60'] : ['--headless=new',
      `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`]),
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) { if (await up()) return; await sleep(250); }
  throw new Error('Chrome did not open its debugging port');
}

async function quitChrome() {
  const { webSocketDebuggerUrl } = await (await http('/json/version')).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  while (await up()) await sleep(250);
}

// Detached child: after IDLE, quit Chrome unless a run used it since or is still going.
// Never touches the visible --login window.
async function reaper() {
  await sleep(IDLE);
  if (Date.now() - statSync(LAST).mtimeMs < IDLE - 1000 || !await up()) return;
  if (readdirSync(TABS).some(id => alive(+readFileSync(join(TABS, id), 'utf8')))) return;
  const headless = await new Promise(r => execFile('pgrep', ['-f', `remote-debugging-port=${PORT} .*--headless`], e => r(!e)));
  if (headless) await quitChrome();
}

function scheduleReap() {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(LAST, '');
  spawn(process.execPath, [process.argv[1], '--reap'], { detached: true, stdio: 'ignore' }).unref();
}

// Close tabs whose run died without cleaning up (SIGKILL, crash).
async function sweep() {
  mkdirSync(TABS, { recursive: true });
  for (const id of readdirSync(TABS)) {
    const pid = +readFileSync(join(TABS, id), 'utf8');
    if (alive(pid)) continue;
    await http(`/json/close/${id}`).catch(() => {});
    try { unlinkSync(join(TABS, id)); } catch {}
  }
}

async function newTab(url) {
  const t = await (await http(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  mkdirSync(TABS, { recursive: true });
  writeFileSync(join(TABS, t.id), String(process.pid));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  // Without this, a dropped socket leaves calls pending forever and every deadline loop hangs.
  ws.onclose = () => { for (const f of pending.values()) f({ error: { message: 'Chrome connection closed' } }); pending.clear(); };
  const call = (method, params = {}) => new Promise((ok, bad) => {
    if (ws.readyState !== WebSocket.OPEN) return bad(new Error('Chrome connection closed'));
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); bad(new Error(`${method}: no reply from Chrome in 60s`)); }, 60000);
    pending.set(n, m => { clearTimeout(timer); m.error ? bad(new Error(`${method}: ${m.error.message}`)) : ok(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expr => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  // ChatGPT backend API, called from inside the page so its session cookie/token apply.
  const api = (path, init = {}) => evaluate(`(async () => {
    window.__tok ??= (await (await fetch('/api/auth/session')).json()).accessToken;
    const init = ${JSON.stringify(init)};
    const r = await fetch('/backend-api/' + ${JSON.stringify(path)}, { ...init,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.__tok } });
    if (!r.ok) throw new Error(${JSON.stringify(path)} + ' HTTP ' + r.status);
    return r.json();
  })()`);
  const download = url => evaluate(`fetch(${JSON.stringify(url)}, { credentials: 'include' })
    .then(r => r.blob()).then(b => new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); }))`);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    ws.close();
    await http(`/json/close/${t.id}`).catch(() => {});
    try { unlinkSync(join(TABS, t.id)); } catch {}
  };
  return { call, evaluate, api, download, close };
}

// Polls swallow transient errors, but a dead Chrome won't come back: rethrow that one.
const soft = fallback => e => { if (e.message === 'Chrome connection closed') throw e; return fallback; };

async function waitFor(tab, expr, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500))
    if (await tab.evaluate(expr).catch(soft(false))) return;
  throw new Error(`timed out waiting for ${what}`);
}

function save(dataUrl, name) {
  const [, mime, data] = dataUrl.match(/^data:image\/(\w+)[^,]*,(.*)$/) ?? [];
  if (!data) throw new Error(`not an image: ${name}`);
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.${mime === 'jpeg' ? 'jpg' : mime}`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const recentImages = (tab, limit) => tab.api(`my/recent/image_gen?limit=${limit}`).then(r => r.items ?? []);

async function generate(tab) {
  await tab.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(tab, `!!document.querySelector(${JSON.stringify(COMPOSER)})`, 30000, 'composer (Cloudflare check or page load stuck?)');
  if (await tab.evaluate(`!!document.querySelector('[data-testid="login-button"]')`))
    throw new Error('not signed in: run `gen.mjs --login` first');

  // A restored draft can carry attachments from an earlier failed run; drop them so they aren't sent.
  await tab.evaluate(`document.querySelectorAll('[data-composer-attachments] button[aria-label^="Remove"]').forEach(b => b.click()), true`);
  await waitFor(tab, `${ATTACHED} === 0`, 5000, 'leftover draft attachments to clear');

  if (refs.length) {
    // Retry: React may swap the file input while the page hydrates, dropping our files.
    // Only resend when nothing landed, or a slow upload gets attached twice.
    for (let i = 0; ; i++) {
      if (await tab.evaluate(ATTACHED) === 0) {
        const { root } = await tab.call('DOM.getDocument', { depth: -1, pierce: true });
        const { nodeId } = await tab.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][multiple][accept^="image"]' });
        if (nodeId) await tab.call('DOM.setFileInputFiles', { nodeId, files: refs });
      }
      try { await waitFor(tab, `${ATTACHED} >= ${refs.length}`, 5000, 'reference upload'); break; } catch (e) { if (i === 4) throw e; }
    }
    // Thumbnails render before the upload finishes; submit stays disabled until it does.
    await waitFor(tab, `!(${UPLOADING})`, 120000, 'reference upload to finish');
  }

  // Clear any draft ChatGPT restored from an earlier failed run, then type.
  await tab.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(COMPOSER)}); c.focus();
    document.execCommand('selectAll'); document.execCommand('delete'); return true })()`);
  await tab.call('Input.insertText', { text: prompt });
  await sleep(500);
  // Send button lost its data-testid; click the form's submit, Enter as fallback.
  if (!await tab.evaluate(`(() => { const b = document.querySelector('form button[type=submit]:not([disabled])'); b?.click(); return !!b })()`))
    for (const type of ['keyDown', 'keyUp'])
      await tab.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  // ChatGPT first routes to a placeholder /c/local-chatgpt:<uuid>; wait for the server's id.
  await waitFor(tab, `/^\\/c\\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(location.pathname)`, 60000, 'conversation id');
  const cid = await tab.evaluate(`location.pathname.split('/')[2]`);
  console.error(`conversation: ${cid}`);

  // Done = server says the assistant turn ended. Images = image pointers in this conversation,
  // else this conversation's entries in the image library (delayed/async generations).
  let ptrs = [], said = '', ended = 0;
  for (const end = Date.now() + 5 * 60000; ; await sleep(3000)) {
    if (Date.now() > end) throw new Error(`timed out waiting for image (conversation ${cid}; try --library --conv ${cid} later)`);
    const c = await tab.api(`conversation/${cid}`).catch(soft(null));
    if (!c) continue;
    const msgs = Object.values(c.mapping).map(n => n.message).filter(Boolean);
    ptrs = [...new Set(msgs.filter(m => m.author.role === 'tool').flatMap(m => m.content.parts ?? [])
      .filter(p => p?.content_type === 'image_asset_pointer').map(p => p.asset_pointer))];
    const last = c.mapping[c.current_node]?.message;
    said = msgs.filter(m => m.author.role === 'assistant').flatMap(m => m.content.parts ?? [])
      .filter(p => typeof p === 'string' && p.trim()).join('\n');
    if (last?.author.role !== 'assistant' || !last.end_turn) continue;
    if (ptrs.length) break;
    const lib = (await recentImages(tab, 20).catch(soft([]))).filter(i => i.conversation_id === cid);
    if (lib.length) { ptrs = lib.map(i => i.asset_pointer); break; }
    if (++ended >= 10) { // ~30s after turn end with nothing: text-only reply
      throw new Error(`no image returned (conversation ${cid}, kept). ChatGPT said:\n${said || '(nothing)'}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [i, ptr] of ptrs.entries()) {
    const fid = ptr.split('://')[1];
    const { download_url } = await tab.api(`files/download/${fid}?conversation_id=${cid}&inline=false`);
    console.log(save(await tab.download(download_url), `chatgpt-${stamp}${ptrs.length > 1 ? `-${i + 1}` : ''}`));
  }
  // Hides the chat from history; OpenAI keeps it, and the image stays in the library.
  if (!keep) await tab.api(`conversation/${cid}`, { method: 'PATCH', body: JSON.stringify({ is_visible: false }) })
    .catch(e => console.error(`warning: chat not hidden: ${e.message}`));
}

// Pull finished images straight from ChatGPT's image library: recovery for runs that lost track.
async function pullLibrary(tab) {
  await waitFor(tab, `document.readyState === 'complete' && location.hostname === 'chatgpt.com'`, 30000, 'chatgpt.com');
  let items = await recentImages(tab, conv ? 50 : count);
  if (conv) items = items.filter(i => i.conversation_id === conv);
  if (!items.length) throw new Error(conv ? `no library images for conversation ${conv}` : 'image library is empty');
  for (const it of items) {
    const slug = (it.title ?? 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const file = save(await tab.download(it.url), `${slug}-${it.id.slice(-8)}`);
    console.log([file, it.title, it.conversation_id, new Date(it.created_at * 1000).toISOString()].join('\t'));
  }
}

if (login) {
  await ensureChrome(true);
  await newTab('https://chatgpt.com/auth/login');
  console.log('Sign in to ChatGPT in the Chrome window that opened, then quit that Chrome (⌘Q). Later runs are headless.');
  process.exit(0);
}

if (reap) { await reaper(); process.exit(0); }

await ensureChrome(false);
const tab = await newTab('https://chatgpt.com/');
const finish = () => tab.close().finally(scheduleReap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => finish().finally(() => process.exit(130)));
try {
  await (library ? pullLibrary(tab) : generate(tab));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await finish();
}
