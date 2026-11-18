import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Icon, Pill } from '../components/ui';
import { mimeFor } from '@proto';
import type { Link } from '../lib/link';
import type { Toast } from '../App';

type Frame = { url: string; codec: number; ts: number; w?: number; h?: number };

function useFrames(link: Link, kind: number) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const urlRef = useRef<string | null>(null);
  const countRef = useRef(0);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const off = link.onFrame((f) => {
      if (f.kind !== kind) return;
      const blob = new Blob([f.payload as any], { type: mimeFor(f.codec) });
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      countRef.current += 1;
      setFrame({ url, codec: f.codec, ts: f.ts });
    });
    const timer = setInterval(() => { setFps(countRef.current); countRef.current = 0; }, 1000);
    return () => {
      off();
      clearInterval(timer);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [link, kind]);

  return { frame, fps };
}

export function Mirror({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const { frame, fps } = useFrames(link, 1);
  const [streaming, setStreaming] = useState(false);
  const [control, setControl] = useState<boolean | null>(link.device?.permissions?.accessibility ?? null);
  const [rate, setRate] = useState(10);
  const [gesture, setGesture] = useState<'tap' | 'swipe' | 'longpress'>('tap');
  const [text, setText] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const [rings, setRings] = useState<Array<{ id: string; x: number; y: number }>>([]);

  const ring = useCallback((x: number, y: number) => {
    const id = Math.random().toString(36).slice(2);
    setRings((r) => [...r, { id, x, y }]);
    setTimeout(() => setRings((r) => r.filter((v) => v.id !== id)), 700);
  }, []);

  const start = useCallback(async () => {
    try {
      const res = await link.request<any>('mirror.start', { fps: rate, quality: 70, maxWidth: 720 });
      setStreaming(true);
      if (typeof res.control === 'boolean') setControl(res.control);
      toast(`mirroring at ${res.fps || rate} fps`, 'ok');
    } catch (e: any) {
      toast(e?.message || 'could not start mirror', 'bad');
    }
  }, [link, rate, toast]);

  const stop = useCallback(async () => {
    try { await link.request('mirror.stop', {}); } catch {}
    setStreaming(false);
  }, [link]);

  useEffect(() => {
    start();
    return () => { link.request('mirror.stop', {}).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pointAt(ev: React.PointerEvent | React.MouseEvent) {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  async function onPointerDown(ev: React.PointerEvent) {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = pointAt(ev);
    if (!p) return;
    down.current = { ...p, t: Date.now() };
  }

  async function onPointerUp(ev: React.PointerEvent) {
    const startPt = down.current;
    down.current = null;
    const p = pointAt(ev);
    if (!startPt || !p) return;
    const dt = Date.now() - startPt.t;
    const dist = Math.hypot(p.x - startPt.x, p.y - startPt.y);
    try {
      if (gesture === 'longpress' || (dt > 550 && dist < 0.02)) {
        ring(startPt.x, startPt.y);
        await link.request('input.longpress', { x: startPt.x, y: startPt.y, ms: Math.max(600, dt) });
      } else if (dist > 0.02 || gesture === 'swipe') {
        await link.request('input.swipe', { x1: startPt.x, y1: startPt.y, x2: p.x, y2: p.y, ms: Math.min(1200, Math.max(120, dt)) });
      } else {
        ring(p.x, p.y);
        await link.request('input.tap', { x: p.x, y: p.y });
      }
    } catch (e: any) {
      toast(e?.message || 'input failed', 'bad');
    }
  }

  async function key(k: string) {
    try { await link.request('input.key', { key: k }); } catch (e: any) { toast(e?.message || 'key failed', 'bad'); }
  }

  async function sendText() {
    if (!text.trim()) return;
    try {
      await link.request('input.text', { text });
      toast('text sent', 'ok');
      setText('');
    } catch (e: any) {
      toast(e?.message || 'text failed', 'bad');
    }
  }

  async function act(action: string, value?: any) {
    try { await link.request('device.action', { action, value }); } catch (e: any) { toast(e?.message || 'action failed', 'bad'); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Mirror &amp; control</h1>
          <p>Frames stream from the device; taps, swipes and keys go back the other way.</p>
        </div>
        <div className="spacer" />
        <Pill tone={streaming ? 'ok' : 'muted'}><span className={streaming ? 'dot dot-live' : 'dot'} /> {streaming ? 'streaming' : 'stopped'}</Pill>
        <span className="fps">{fps} fps</span>
      </div>

      <div className="mirror-wrap">
        <div className="stage">
          <div className="device-shell">
            <div className="device-screen">
              {frame ? (
                <div style={{ position: 'relative', display: 'flex' }}>
                  <img
                    ref={imgRef}
                    src={frame.url}
                    alt="device screen"
                    draggable={false}
                    onPointerDown={onPointerDown}
                    onPointerUp={onPointerUp}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                  {rings.map((r) => (
                    <span
                      key={r.id}
                      style={{
                        position: 'absolute', left: `${r.x * 100}%`, top: `${r.y * 100}%`,
                        width: 42, height: 42, marginLeft: -21, marginTop: -21, borderRadius: '50%',
                        border: '2px solid rgba(127,178,255,.85)', pointerEvents: 'none',
                        animation: 'pulse .7s ease-out both',
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="no-frame">
                  <div style={{ textAlign: 'center' }}>
                    <Icon name="mirror" size={30} />
                    <div style={{ marginTop: 8, fontSize: 12 }}>waiting for the first frame…</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mirror-side">
          <Card title="Session">
            <div className="kv"><span>Gesture</span><span>{gesture}</span></div>
            <div className="kv"><span>Frame rate</span><span>{fps} fps</span></div>
            <div className="kv"><span>Codec</span><span>{frame ? (frame.codec === 1 ? 'jpeg' : frame.codec === 2 ? 'webp' : frame.codec === 3 ? 'svg (demo)' : 'png') : '—'}</span></div>
            <div className="kv"><span>Last frame</span><span>{frame ? new Date(frame.ts * 1000).toLocaleTimeString() : '—'}</span></div>
            <div className="row mt-16">
              <button className="btn btn-sm grow" onClick={() => (streaming ? stop() : start())}>
                <Icon name={streaming ? 'pause' : 'play'} size={14} /> {streaming ? 'Stop' : 'Start'}
              </button>
              <select className="select" style={{ width: 92 }} value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                {[5, 10, 15, 20].map((v) => <option key={v} value={v}>{v} fps</option>)}
              </select>
            </div>
          </Card>

          <Card title="Pointer">
            <div className="segmented" style={{ width: '100%', justifyContent: 'space-between' }}>
              {(['tap', 'swipe', 'longpress'] as const).map((g) => (
                <button key={g} className={gesture === g ? 'active' : ''} onClick={() => setGesture(g)}>
                  {g === 'longpress' ? 'hold' : g}
                </button>
              ))}
            </div>
            <p className="faint" style={{ fontSize: 11.5, marginBottom: 0 }}>
              Tap the screen to send a single tap. Drag to swipe. Long-press sends a hold.
            </p>
          </Card>

          <Card title="Keyboard">
            <div className="row">
              <input
                className="input"
                placeholder="Type on the phone…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendText(); }}
              />
              <button className="btn btn-primary btn-sm" onClick={sendText}>Send</button>
            </div>
            <div className="keybar mt-16">
              <button className="tool" onClick={() => key('home')}><Icon name="grid" size={15} /> Home</button>
              <button className="tool" onClick={() => key('back')}><Icon name="back" size={15} /> Back</button>
              <button className="tool" onClick={() => key('recents')}><Icon name="folder" size={15} /> Recents</button>
              <button className="tool" onClick={() => key('backspace')}><Icon name="x" size={15} /> Delete</button>
              <button className="tool" onClick={() => key('enter')}><Icon name="check" size={15} /> Enter</button>
              <button className="tool" onClick={() => key('power')}><Icon name="power" size={15} /> Power</button>
            </div>
          </Card>

          <Card title="Device">
            <div className="tool-group">
              <button className="tool" onClick={() => act('volume.down')}><Icon name="volume" size={15} /> Vol −</button>
              <button className="tool" onClick={() => act('volume.up')}><Icon name="volume" size={15} /> Vol +</button>
              <button className="tool" onClick={() => act('volume.mute')}><Icon name="volume" size={15} /> Mute</button>
              <button className="tool" onClick={() => act('wake')}><Icon name="sun" size={15} /> Wake</button>
              <button className="tool" onClick={() => act('lock')}><Icon name="lock" size={15} /> Lock</button>
              <button className="tool" onClick={() => act('flashlight')}><Icon name="star" size={15} /> Torch</button>
            </div>
            <div className="row mt-16">
              <button
                className="btn btn-sm grow"
                onClick={async () => {
                  try {
                    const t = await navigator.clipboard.readText();
                    await act('clipboard.set', t);
                    toast('clipboard sent to phone', 'ok');
                  } catch { toast('clipboard permission denied', 'bad'); }
                }}
              >
                <Icon name="clipboard" size={14} /> Send clipboard
              </button>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    const r = await link.request<any>('device.action', { action: 'clipboard.get' });
                    await navigator.clipboard.writeText(r?.text || '');
                    toast('copied phone clipboard', 'ok');
                  } catch { toast('could not read clipboard', 'bad'); }
                }}
              >
                <Icon name="clipboard" size={14} /> Get
              </button>
            </div>
          </Card>

          <div className="warn-strip">
            <Icon name={control === false ? 'warning' : 'shield'} size={15} />
            <span>
              {control === false
                ? 'View-only: the accessibility service is off, so taps, swipes and keys are ignored by the phone.'
                : control === true
                  ? 'Touch, keyboard and hardware keys are injected through the Airlock accessibility service.'
                  : 'Enable the Airlock accessibility service on the phone to unlock remote control.'}
            </span>
            {control === false && (
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={async () => {
                  try {
                    await link.request('device.permission', { permission: 'accessibility' });
                    toast('accessibility settings opened on the phone', 'ok');
                  } catch (e: any) {
                    toast(e?.message || 'open Airlock → Permissions on the phone', 'warn');
                  }
                }}
              >
                Enable
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
