import React, { useEffect, useRef, useState } from 'react';
import { Card, Empty, Icon, Pill, Spinner } from '../components/ui';
import { mimeFor } from '@proto';
import type { Link } from '../lib/link';
import type { Toast } from '../App';

export function CameraView({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const [lens, setLens] = useState<'back' | 'front'>('back');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<{ url: string; ts: number } | null>(null);
  const urlRef = useRef<string | null>(null);
  const timer = useRef<any>(null);

  useEffect(() => {
    const off = link.onFrame((f) => {
      if (f.kind !== 2) return;
      const url = URL.createObjectURL(new Blob([f.payload as any], { type: mimeFor(f.codec) }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setShot({ url, ts: f.ts });
    });
    return () => {
      off();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [link]);

  async function take(l = lens) {
    setBusy(true);
    try {
      await link.request('camera.shot', { lens: l });
    } catch (e: any) {
      toast(e?.message || 'snapshot failed', 'bad');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    clearInterval(timer.current);
    if (live) {
      take();
      timer.current = setInterval(() => take(), 1500);
    }
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, lens]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Remote camera</h1>
          <p>One frame per request; “live” polls at 0.7 fps. Real implementations use CameraX + WebRTC.</p>
        </div>
        <div className="spacer" />
        <Pill tone={live ? 'ok' : 'muted'}><span className={live ? 'dot dot-live' : 'dot'} /> {live ? 'live' : 'idle'}</Pill>
      </div>

      <div className="cam-wrap">
        <div className="cam-stage">
          {shot ? (
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
            <div className="kv"><span>Resolution</span><span>4032 × 3024</span></div>
          </Card>

          <div className="warn-strip">
            <Icon name="shield" size={15} />
            <span>
              Camera access requires a foreground service with type <code>camera</code> and a
              visible notification on Android 14+. Airlock never records silently.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
