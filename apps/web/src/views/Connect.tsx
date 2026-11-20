import React, { useState } from 'react';
import { Card, Icon, Spinner, Pill } from '../components/ui';
import { claimPairCode, cloudSocketUrl, Connection } from '../lib/link';

type Props = {
  onConnect: (c: Connection) => void;
  busy: boolean;
  error: string;
  relayDefault: string;
  last?: Connection | null;
};

export function Connect({ onConnect, busy, error, relayDefault, last }: Props) {
  const [mode, setMode] = useState<'demo' | 'lan' | 'cloud'>('demo');
  const [host, setHost] = useState('192.168.1.20');
  const [port, setPort] = useState('8787');
  const [code, setCode] = useState(mode === 'demo' ? '123456' : '');
  const [relay, setRelay] = useState(relayDefault);
  const [localErr, setLocalErr] = useState('');
  const [claiming, setClaiming] = useState(false);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setLocalErr('');
    if (mode === 'demo') {
      onConnect({
        mode: 'demo',
        label: 'Demo device · localhost',
        url: 'ws://localhost:8787/agent',
        code: '123456',
      });
      return;
    }
    if (mode === 'lan') {
      const url = `ws://${host.trim()}:${port.trim()}/agent`;
      onConnect({ mode: 'lan', label: `LAN · ${host.trim()}`, url, code: code.trim() });
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) { setLocalErr('Enter the 6-digit code shown on the phone.'); return; }
    setClaiming(true);
    try {
      const { room, token } = await claimPairCode(relay, code.trim());
      onConnect({
        mode: 'cloud',
        label: `Cloud · room ${code.trim()}`,
        url: cloudSocketUrl(relay, room, token, 'controller'),
        relay,
        room,
        token,
      });
    } catch (err: any) {
      setLocalErr(err?.message || 'could not claim code');
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="connect">
      <div className="connect-hero">
        <div className="row" style={{ marginBottom: 18 }}>
          <span className="brand-mark" style={{ width: 30, height: 30, borderRadius: 9 }}><Icon name="phone" size={16} /></span>
          <span className="brand-name">Airlock</span>
          <Pill tone="info">open source</Pill>
        </div>
        <h1>Your phone,<br /><span>on your desktop.</span></h1>
        <p className="lead">
          Files, screen mirroring, remote control, SMS, notifications and the camera —
          from any browser, over your LAN or through a free relay. No ads, no
          telemetry, no account required.
        </p>

        <div className="connect-feats">
          {[
            ['folder', 'File manager', 'Browse, upload, download, rename, delete. Checksummed.'],
            ['mirror', 'Mirror & control', 'Live screen at 10 fps with tap, swipe and typing.'],
            ['message', 'SMS inbox', 'Read threads and send texts from the keyboard.'],
            ['bell', 'Notifications', 'Live feed with inline replies.'],
            ['camera', 'Remote camera', 'Snap front or back lens on demand.'],
            ['shield', 'Pairing code', 'Six digits, single use, relay never stores files.'],
          ].map(([icon, title, body]) => (
            <div className="connect-feat" key={title}>
              <Icon name={icon} size={17} />
              <div><b>{title}</b><span>{body}</span></div>
            </div>
          ))}
        </div>
      </div>

      <Card className="connect-card">
        <h2>Connect a device</h2>
        <p>Run the demo agent, dial a phone on your Wi-Fi, or join a cloud room.</p>

        <div className="segmented" style={{ marginBottom: 16 }}>
          <button className={mode === 'demo' ? 'active' : ''} onClick={() => { setMode('demo'); setCode('123456'); }}>Demo</button>
          <button className={mode === 'lan' ? 'active' : ''} onClick={() => { setMode('lan'); setCode(''); }}>Local network</button>
          <button className={mode === 'cloud' ? 'active' : ''} onClick={() => { setMode('cloud'); setCode(''); }}>Cloud relay</button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'demo' && (
            <div className="field">
              <label>Reference agent</label>
              <div className="codeblock">
                <span className="k">npm</span> install<br />
                <span className="k">npm</span> run agent
              </div>
              <span className="hint">Starts a simulated phone on <code>ws://localhost:8787</code> with code 123456.</span>
            </div>
          )}

          {mode === 'lan' && (
            <>
              <div className="row">
                <div className="field grow">
                  <label>Phone IP</label>
                  <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.20" />
                </div>
                <div className="field" style={{ width: 96 }}>
                  <label>Port</label>
                  <input className="input" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8787" />
                </div>
              </div>
              <div className="field">
                <label>Pairing code</label>
                <input className="input code-input" style={{ fontSize: 20 }} value={code} maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" inputMode="numeric" />
                <span className="hint">Shown by the Airlock app on the phone.</span>
              </div>
            </>
          )}

          {mode === 'cloud' && (
            <>
              <div className="field">
                <label>Relay URL</label>
                <input className="input" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="https://airlock-relay.fly.dev" />
                <span className="hint">Any HTTPS host that can hold a WebSocket. Free tiers work.</span>
              </div>
              <div className="field">
                <label>Six-digit code</label>
                <input className="input code-input" value={code} maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" inputMode="numeric" />
                <span className="hint">Pick it from the phone's home screen, or scan its QR.</span>
              </div>
            </>
          )}

          {(error || localErr) && (
            <div className="err"><Icon name="warning" size={15} /><span>{localErr || error}</span></div>
          )}

          <button className="btn btn-primary btn-block" disabled={busy || claiming} type="submit">
            {(busy || claiming) ? <Spinner /> : <Icon name="link" size={16} />}
            {mode === 'cloud' ? 'Join cloud room' : 'Connect'}
          </button>
          {last && (
            <button type="button" className="btn btn-ghost btn-block btn-sm" onClick={() => onConnect(last)}>
              <Icon name="refresh" size={14} /> Reconnect to {last.label}
            </button>
          )}
        </form>

        <div className="connect-foot">
          <Icon name="shield" size={14} />
          <span>Pairing code is single-use. The relay sees only routing metadata.</span>
        </div>

        <div className="connect-foot">
          <Icon name="phone" size={14} />
          <span>
            Android agent:{' '}
            <a href="/airlock-1.0.4-debug.apk" download>
              download the APK
            </a>{' '}
            (debug build, sideload)
          </span>
        </div>
      </Card>
    </div>
  );
}
