import { decodeFrame, encodeFrame, FrameKind, CHUNK_BYTES, mimeFor } from '@proto';

export type LinkStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error';

export type Frame = {
  kind: number;
  codec: number;
  stream: number;
  ts: number;
  payload: Uint8Array;
};

export type Connection = {
  mode: 'demo' | 'lan' | 'cloud';
  label: string;
  url: string;
  code?: string;
  relay?: string;
  room?: string;
  token?: string;
};

export type DeviceInfo = {
  id: string;
  name: string;
  model?: string;
  android?: string;
  agent?: string;
  ip?: string;
  port?: number;
  silentCapture?: boolean;
  capabilities?: string[];
  permissions?: {
    camera?: boolean;
    smsRead?: boolean;
    smsSend?: boolean;
    notifications?: boolean;
    accessibility?: boolean;
    screenshot?: boolean;
    allFiles?: boolean;
    battery?: boolean;
  };
  silent?: boolean;
};

export type Stats = {
  battery?: number;
  charging?: boolean;
  volume?: number;
  muted?: boolean;
  cpu?: number;
  mem?: { total: number; free: number };
  storage?: { total: number; used: number; free: number };
  network?: { type?: string; ssid?: string; ip?: string; signal?: number };
  uptime?: number;
  time?: number;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Link {
  ws: WebSocket | null = null;
  status: LinkStatus = 'idle';
  detail = '';
  device: DeviceInfo | null = null;
  onStatus?: (s: LinkStatus, detail: string) => void;
  onDevice?: (d: DeviceInfo) => void;
  onStats?: (s: Stats) => void;
  onEvent?: (type: string, data: any) => void;

  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>();
  private frameSubs = new Set<(f: Frame) => void>();
  private eventSubs = new Set<(type: string, data: any) => void>();
  private opts: Connection | null = null;
  private retry = 2500;
  private timer: any = null;
  private manualClose = false;

  private setStatus(s: LinkStatus, detail = '') {
    this.status = s;
    this.detail = detail;
    this.onStatus?.(s, detail);
  }

  subscribeEvent(cb: (type: string, data: any) => void) {
    this.eventSubs.add(cb);
    return () => { this.eventSubs.delete(cb); };
  }

  private emit(type: string, data: any) {
    this.onEvent?.(type, data);
    this.eventSubs.forEach((cb) => cb(type, data));
  }

  get online() {
    return this.status === 'online' && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(opts: Connection) {
    this.manualClose = false;
    this.opts = opts;
    this.open();
  }

  private open() {
    const opts = this.opts;
    if (!opts) return;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.setStatus('connecting', opts.label);
    let ws: WebSocket;
    try {
      ws = new WebSocket(opts.url);
    } catch (e: any) {
      this.setStatus('error', e?.message || 'could not open socket');
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 2500;
      this.setStatus('online', opts.label);
      if (opts.mode !== 'cloud' && opts.code) {
        this.request('auth', { code: opts.code }, 12000).catch((e) => {
          this.setStatus('error', e?.message || 'pairing rejected');
        });
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'hello') {
          const info: DeviceInfo = {
            ...(msg.data?.device || {}),
            capabilities: msg.data?.capabilities,
            permissions: msg.data?.permissions,
            silent: msg.data?.silent,
          };
          this.device = info;
          this.onDevice?.(info);
          return;
        }
        if (msg.type === 'event:stats') { this.onStats?.(msg.data || {}); this.emit('stats', msg.data || {}); return; }
        if (msg.type?.startsWith('res:') && msg.replyTo) {
          const p = this.pending.get(msg.replyTo);
          if (!p) return;
          this.pending.delete(msg.replyTo);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error?.message || 'request failed'));
          return;
        }
        if (msg.type === 'relay.peer.left') { this.emit('peer.left', msg.data); return; }
        if (msg.type === 'relay.peer.joined') { this.emit('peer.joined', msg.data); return; }
        if (msg.type?.startsWith('event:')) { this.emit(msg.type.slice(6), msg.data); return; }
        this.emit('message', msg);
        return;
      }
      const frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
      if (frame) this.frameSubs.forEach((cb) => cb(frame));
    };

    ws.onclose = (ev) => {
      if (this.manualClose) { this.setStatus('idle'); return; }
      this.setStatus('reconnecting', ev.reason || 'connection lost');
      this.scheduleRetry();
    };

    ws.onerror = () => {
      if (this.status === 'online') this.setStatus('reconnecting', 'socket error');
    };
  }

  private scheduleRetry() {
    clearTimeout(this.timer);
    const delay = this.retry;
    this.retry = Math.min(15000, Math.round(this.retry * 1.5));
    this.timer = setTimeout(() => this.open(), delay);
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.device = null;
    this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('disconnected')); });
    this.pending.clear();
    this.setStatus('idle');
  }

  request<T = any>(type: string, data: any = {}, timeout = 30000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), type, data }));
    });
  }

  onFrame(cb: (f: Frame) => void) {
    this.frameSubs.add(cb);
    return () => { this.frameSubs.delete(cb); };
  }

  async upload(dirPath: string, file: File, onProgress?: (sent: number, total: number) => void) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256Hex(bytes);
    const begin = await this.request('fs.upload.begin', {
      path: dirPath, name: file.name, size: bytes.length, sha256: digest,
    });
    for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
      const part = bytes.subarray(off, Math.min(off + CHUNK_BYTES, bytes.length));
      this.ws!.send(encodeFrame({ kind: FrameKind.UPLOAD, stream: 1 }, part));
      onProgress?.(Math.min(off + part.length, bytes.length), bytes.length);
      if ((off / CHUNK_BYTES) % 12 === 0) await wait(0);
    }
    return this.request('fs.upload.done', { uploadId: begin.uploadId, sha256: digest }, 30000);
  }

  async download(path: string, onProgress?: (received: number, total?: number) => void): Promise<{ blob: Blob; name: string; size: number }> {
    const chunks: Uint8Array[] = [];
    let received = 0;
    const off = this.onFrame((f) => {
      if (f.kind !== FrameKind.DOWNLOAD) return;
      // copy: the underlying ArrayBuffer can be reused by the browser
      chunks.push(f.payload.slice());
      received += f.payload.byteLength;
      onProgress?.(received);
    });
    try {
      const res = await this.request<any>('fs.download', { path }, 600000);
      return { blob: new Blob(chunks as any), name: res.name, size: res.size };
    } finally {
      off();
    }
  }

  async preview(path: string, timeout = 30000): Promise<{ url: string; bytes: number }> {
    let url: string | null = null;
    let bytes = 0;
    let notify: (() => void) | null = null;
    const arrived = new Promise<void>((resolve) => { notify = resolve; });
    const off = this.onFrame((f) => {
      if (f.kind !== FrameKind.PREVIEW) return;
      // A newer preview supersedes the previous temporary object URL.
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([f.payload as any], { type: mimeFor(f.codec) }));
      bytes = f.payload.byteLength;
      notify?.();
    });
    const started = Date.now();
    try {
      const res = await this.request<any>('fs.preview', { path }, timeout);
      // The agent replies as soon as the JPEG is encoded and streams the frame
      // right after. On a slow mobile uplink that frame can trail the reply by
      // several seconds, so wait out the remaining budget instead of a fixed
      // two seconds (which made previews fail while the frame was in flight).
      if (!url) {
        const left = Math.max(2000, timeout - (Date.now() - started));
        await Promise.race([arrived, wait(left)]);
      }
      if (!url) throw new Error('preview frame did not arrive');
      return { url, bytes: res?.bytes ?? bytes };
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      throw e;
    } finally {
      off();
    }
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh buffer: TS types crypto.subtle as needing an ArrayBuffer
  // (not a possibly-shared ArrayBufferLike).
  const copy = new Uint8Array(bytes);
  const buf = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function claimPairCode(relay: string, code: string) {
  const base = relay.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('code not found or expired');
  return (await res.json()) as { room: string; token: string };
}

export function cloudSocketUrl(relay: string, room: string, token: string, role: 'controller' | 'device') {
  const base = relay.replace(/\/+$/, '');
  return `${base.replace(/^http/, 'ws')}/ws?role=${role}&room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
}
