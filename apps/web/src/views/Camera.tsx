import React, { useEffect, useRef, useState } from 'react';
import { Card, Empty, Icon, Pill, Spinner } from '../components/ui';
import { mimeFor } from '@proto';
import type { Link } from '../lib/link';
import type { Toast } from '../App';
import { formatBytes } from '../lib/util';

type ShotMeta = { url?: string; ts: number; width?: number; height?: number; bytes?: number };

export function CameraView({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const [lens, setLens] = useState<'back' | 'front'>('back');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<ShotMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const urlRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const failures = useRef(0);

  useEffect(() => {
    const off = link.onFrame((f) => {
      if (f.kind !== 2) return;
      const url = URL.createObjectURL(new Blob([f.payload as any], { type: mimeFor(f.codec) }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setShot((prev) => ({ ...(prev || { ts: f.ts }), url, ts: f.ts }));
    });
    return () => {
      off();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [link]);

  // One request at a time. The old 1.5s interval could stack captures, which
  // queued multi-megabyte JPEGs ahead of every other reply on the phone.
  async function take(l: 'back' | 'front' = lens, quiet = false): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    const started = performance.now();
    try {
      const res = await link.request<any>('camera.shot', { lens: l }, 35000);
      setLatency(Math.round(performance.now() - started));
      setShot((prev) => ({
        ...(prev || { ts: Date.now() / 1000 }),
        width: res?.width,
        height: res?.height,
        bytes: res?.bytes,
      }));
      setError(null);
      failures.current = 0;
      return true;
    } catch (e: any) {
      const message = e?.message || 'snapshot failed';
      setError(message);
      failures.current += 1;
      if (!quiet || failures.current === 1) toast(message, 'bad');
      if (failures.current >= 3) setLive(false);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const ok = await take(lens, true);
        // Back off on errors so a broken camera does not spin hot.
        await new Promise((r) => setTimeout(r, ok ? 400 : 2500));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, lens]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Remote camera</h1>
          <p>One frame per request; “live” captures back-to-back without overlapping. Frames are capped at 1440 px to keep the link responsive.</p>
        </div>
        <div className="spacer" />
        <Pill tone={live ? 'ok' : 'muted'}><span className={live ? 'dot dot-live' : 'dot'} /> {live ? 'live' : 'idle'}</Pill>
      </div>

      <div className="cam-wrap">
        <div className="cam-stage">
          {shot?.url ? (
            <img src={shot.url} alt="camera frame" />
          ) : (
            <Empty icon="camera" title="No frame yet" body="Press “Snapshot” to pull a frame from the device camera." />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Capture">
            <div className="segmented" style={{ width: '100%', marginBottom: 12 }}>
              <button className={lens === 'back' ? 'active' : ''} onClick={() => setLens('back')}>Back lens</button>
              <button className={lens === 'front' ? 'active' : ''} onClick={() => setLens('front')}>Front lens</button>
            </div>
            <div className="row">
              <button className="btn btn-primary grow" onClick={() => take()} disabled={busy}>
                {busy ? <Spinner size={14} /> : <Icon name="camera" size={15} />} Snapshot
              </button>
              <button className={`btn ${live ? 'btn-danger' : ''}`} onClick={() => setLive(!live)}>
                <Icon name={live ? 'pause' : 'play'} size={14} /> {live ? 'Stop' : 'Live'}
              </button>
            </div>
            <div className="kv mt-16"><span>Lens</span><span>{lens}</span></div>
            <div className="kv"><span>Last frame</span><span>{shot ? new Date(shot.ts * 1000).toLocaleTimeString() : '—'}</span></div>
            <div className="kv">
              <span>Resolution</span>
              <span>{shot?.width && shot?.height ? `${shot.width} × ${shot.height}` : '—'}</span>
            </div>
            <div className="kv"><span>Frame size</span><span>{shot?.bytes ? formatBytes(shot.bytes) : '—'}</span></div>
            <div className="kv"><span>Round trip</span><span>{latency !== null ? `${latency} ms` : '—'}</span></div>
            {error && <p className="faint" style={{ color: '#f87171', fontSize: 12, marginBottom: 0 }}>{error}</p>}
          </Card>

          <div className="warn-strip">
            <Icon name="shield" size={15} />
            <span>
              Camera access needs the runtime camera permission and a foreground service of type
              <code>camera</code> on Android 14+. Airlock never records silently; the capture
              notification is mandatory.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
