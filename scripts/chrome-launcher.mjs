// chrome-launcher.mjs - Cross-platform Google Chrome launcher & CDP connection manager
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDPClient } from './cdp-client.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findChromeBinary(explicitPath) {
  if (explicitPath) {
    try {
      await access(explicitPath);
      return explicitPath;
    } catch {
      throw new Error(`Specified Chrome executable not found: ${explicitPath}`);
    }
  }

  const platform = process.platform;
  let candidates = [];

  if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
  } else if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const prog = process.env.PROGRAMFILES || '';
    const prog86 = process.env['PROGRAMFILES(X86)'] || '';
    candidates = [
      join(local, 'Google/Chrome/Application/chrome.exe'),
      join(prog, 'Google/Chrome/Application/chrome.exe'),
      join(prog86, 'Google/Chrome/Application/chrome.exe'),
      join(prog86, 'Microsoft/Edge/Application/msedge.exe'),
      join(prog, 'Microsoft/Edge/Application/msedge.exe'),
      join(local, 'Microsoft/Edge/Application/msedge.exe'),
      join(local, 'Chromium/Application/chrome.exe')
    ];
  } else {
    // Linux
    const names = [
      'google-chrome-stable',
      'google-chrome',
      'microsoft-edge-stable',
      'microsoft-edge',
      'brave-browser',
      'chromium',
      'chromium-browser'
    ];
    for (const name of names) {
      try {
        const out = execFileSync('which', [name], { encoding: 'utf8' }).trim();
        if (out) candidates.push(out);
      } catch {}
    }
  }

  for (const p of candidates) {
    if (!p) continue;
    try {
      await access(p);
      return p;
    } catch {}
  }

  throw new Error('Google Chrome executable not found. Please install Chrome or specify path with --chrome <path>');
}

export async function connectViaProfile(stateDir) {
  const activePortFile = join(stateDir, 'chrome-profile', 'DevToolsActivePort');
  try {
    const content = (await readFile(activePortFile, 'utf8')).trim().split('\n');
    const port = Number(content[0]);
    const wsPath = content[1] || '';
    const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    return await CDPClient.connect(wsUrl);
  } catch (err) {
    // If not found in profile, try checking if 127.0.0.1:9222 has active Chrome
    try {
      const resp = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json());
      if (resp && resp.webSocketDebuggerUrl) {
        return await CDPClient.connect(resp.webSocketDebuggerUrl);
      }
    } catch {}
    throw err;
  }
}

export async function launchChrome({
  stateDir = './state',
  url = 'https://tsjy.chaoxing.com/',
  chromePath = null,
  headless = false
} = {}) {
  const absStateDir = resolve(stateDir);
  const profileDir = join(absStateDir, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });

  // 1. Try to connect if Chrome with this profile is already running
  try {
    const cdp = await connectViaProfile(absStateDir);
    const pages = await cdp.targets();
    let target = pages.find(p => p.url.includes('chaoxing.com')) || pages[0];
    if (!target) {
      const tid = await cdp.createTarget(url);
      target = { targetId: tid, url };
    }
    return { cdp, targetId: target.targetId, reused: true, stateDir: absStateDir };
  } catch {}

  // 2. Launch new Chrome instance
  const binary = await findChromeBinary(chromePath);
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    url
  ];

  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore'
  });

  const launchErrPromise = new Promise((_, reject) => child.once('error', reject));
  child.unref();

  // 3. Poll for DevToolsActivePort
  const connectPromise = (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const cdp = await connectViaProfile(absStateDir);
        const pages = await cdp.targets();
        const page = pages.find(p => p.url === url || p.url.includes('chaoxing.com')) || pages.find(p => p.url !== 'chrome://newtab/');
        if (page) {
          // Save connection metadata
          await writeFile(
            join(absStateDir, 'connection.json'),
            JSON.stringify({ pid: child.pid, targetId: page.targetId, stateDir: absStateDir, startedAt: new Date().toISOString() }, null, 2)
          );
          return { cdp, targetId: page.targetId, reused: false, stateDir: absStateDir };
        }
        cdp.close();
      } catch {}
      await sleep(250);
    }
    throw new Error('Chrome started but CDP failed to become ready within 20s.');
  })();

  return Promise.race([connectPromise, launchErrPromise]);
}

// CLI entrypoint if executed directly
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  const getOpt = (flag, def = null) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  try {
    if (cmd === 'doctor') {
      const chrome = await findChromeBinary(getOpt('--chrome'));
      console.log(JSON.stringify({
        node: process.version,
        platform: process.platform,
        chrome,
        nativeWebSocket: typeof globalThis.WebSocket === 'function'
      }, null, 2));
    } else if (cmd === 'open') {
      const url = getOpt('--url', 'https://tsjy.chaoxing.com/');
      const stateDir = getOpt('--state-dir', './state');
      const res = await launchChrome({ url, stateDir, chromePath: getOpt('--chrome') });
      console.log(JSON.stringify({
        success: true,
        reused: res.reused,
        targetId: res.targetId,
        stateDir: res.stateDir
      }, null, 2));
      res.cdp.close();
    } else {
      console.log('Usage:');
      console.log('  node chrome-launcher.mjs doctor');
      console.log('  node chrome-launcher.mjs open --url <URL> [--state-dir ./state]');
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}
