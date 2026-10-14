// cdp-client.mjs - Lightweight, zero-dependency Chrome DevTools Protocol Client
// Requires Node.js 20+ with native fetch and WebSocket (Node.js 22+ recommended).

import { writeFile } from 'node:fs/promises';

export class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.cmdId = 0;
    this.pending = new Map();
    this.sessions = new Map();

    const onMessage = (e) => {
      try {
        const raw = typeof e.data === 'string' ? e.data : e.data.toString();
        const msg = JSON.parse(raw);
        if (msg.method === 'Target.attachedToTarget') {
          const { sessionId, targetInfo } = msg.params;
          this.sessions.set(targetInfo.targetId, sessionId);
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (err) {
        // Ignore unparseable frames
      }
    };

    const onClose = () => {
      for (const { timer, reject } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      this.sessions.clear();
    };

    if (ws.addEventListener) {
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
    } else if (ws.on) {
      ws.on('message', (d) => onMessage({ data: d }));
      ws.on('close', onClose);
    }
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error('Global WebSocket is not available. Please use Node.js 22+');

    const ws = new WS(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`WebSocket connection to ${wsUrl} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onOpen = () => {
        clearTimeout(timer);
        resolve();
      };
      const onError = (e) => {
        clearTimeout(timer);
        reject(new Error(e?.message || 'WebSocket connection error'));
      };

      if (ws.addEventListener) {
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
      } else if (ws.once) {
        ws.once('open', onOpen);
        ws.once('error', onError);
      }
    });

    const client = new CDPClient(ws);
    // Enable target discovery
    await client.call('Target.setDiscoverTargets', { discover: true });
    return client;
  }

  call(method, params = {}, sessionId = null, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        return reject(new Error('WebSocket is not open'));
      }
      const id = ++this.cmdId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method} (id=${id})`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async session(targetId) {
    if (!this.sessions.has(targetId)) {
      const resp = await this.call('Target.attachToTarget', { targetId, flatten: true });
      this.sessions.set(targetId, resp.sessionId);
    }
    return this.sessions.get(targetId);
  }

  async evaluate(targetId, expression, timeoutMs = 30000) {
    const sid = await this.session(targetId);
    const resp = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sid, timeoutMs);

    if (resp.exceptionDetails) {
      const msg = resp.exceptionDetails.exception?.description || resp.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${msg}`);
    }
    return resp.result?.value;
  }

  async screenshot(targetId, outputPath, options = {}) {
    const sid = await this.session(targetId);
    const params = { format: 'png', ...options };
    const resp = await this.call('Page.captureScreenshot', params, sid, 20000);
    const buffer = Buffer.from(resp.data, 'base64');
    await writeFile(outputPath, buffer);
    return buffer;
  }

  async targets() {
    const resp = await this.call('Target.getTargets');
    return (resp.targetInfos || []).filter(t => t.type === 'page');
  }

  async createTarget(url = 'about:blank') {
    const resp = await this.call('Target.createTarget', { url, newWindow: false });
    return resp.targetId;
  }

  async closeTarget(targetId) {
    const resp = await this.call('Target.closeTarget', { targetId });
    this.sessions.delete(targetId);
    return resp;
  }

  async navigate(targetId, url) {
    const sid = await this.session(targetId);
    return this.call('Page.navigate', { url }, sid);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
