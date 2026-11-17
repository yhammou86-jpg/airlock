import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, LinkStatus, Connection, DeviceInfo, Stats, claimPairCode, cloudSocketUrl } from './lib/link';
import { Icon, Pill } from './components/ui';
import { clsx, formatUptime } from './lib/util';
import { Connect } from './views/Connect';
import { Overview } from './views/Overview';
import { Files } from './views/Files';
import { Mirror } from './views/Mirror';
import { Messages } from './views/Messages';
import { Notifications } from './views/Notifications';
import { CameraView } from './views/Camera';
import { Settings } from './views/Settings';

export type LogEntry = { id: string; ts: number; level: 'info' | 'warn' | 'error'; message: string };
export type Toast = { id: string; tone: 'ok' | 'bad' | 'warn' | 'info'; text: string };

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'mirror', label: 'Mirror & control', icon: 'mirror' },
  { id: 'messages', label: 'Messages', icon: 'message' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
];

const TITLES: Record<string, [string, string]> = {
  overview: ['Overview', 'Device health, storage and quick actions'],
  files: ['Files', 'Browse and transfer files on the device'],
  mirror: ['Mirror & control', 'Live screen with touch, keyboard and hardware keys'],
  messages: ['Messages', 'SMS threads on the device'],
  notifications: ['Notifications', 'Live notification feed with replies'],
  camera: ['Camera', 'Remote snapshots from the device camera'],
  settings: ['Settings', 'Connection, permissions and security'],
};

export default function App() {
  const linkRef = useRef<Link | null>(null);
  if (!linkRef.current) linkRef.current = new Link();
  const link = linkRef.current;

  const [status, setStatus] = useState<LinkStatus>('idle');
  const [detail, setDetail] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState('');
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [stats, setStats] = useState<Stats>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [nav, setNav] = useState(() => {
    const v = new URLSearchParams(location.search).get('view');
    return v && NAV.some((n) => n.id === v) ? v : 'overview';
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const [last, setLast] = useState<Connection | null>(() => {
    try { return JSON.parse(localStorage.getItem('airlock.last') || 'null'); } catch { return null; }
  });
  const [relayDefault] = useState(() => {
    const q = new URLSearchParams(location.search).get('relay');
    if (q) return q;
    const env = import.meta.env.VITE_RELAY_URL?.trim();
    if (env) return env.replace(/\/+$/, '');
    return location.hostname === 'localhost' ? 'http://localhost:8788' : '';
  });

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const log = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs((l) => [{ id: Math.random().toString(36).slice(2), ts: Date.now(), level, message }, ...l].slice(0, 80));
  }, []);

  useEffect(() => {
    link.onStatus = (s, d) => {
      setStatus(s);
      setDetail(d);
      if (s === 'online') { setConnecting(false); setErr(''); }
      if (s === 'error') { setConnecting(false); setErr(d); }
    };
    link.onDevice = (d) => {
      setDevice(d);
      log(`paired with ${d.name || d.id}`);
    };
    link.onStats = (s) => setStats((prev) => ({ ...prev, ...s }));
    link.onEvent = (type, data) => {
      if (type === 'log') {
        log(data?.message || '', data?.level === 'error' ? 'error' : data?.level === 'warn' ? 'warn' : 'info');
      } else if (type === 'notif') {
        setUnread((n) => n + 1);
      } else if (type === 'peer.left') {
        toast('Device link dropped', 'warn');
      } else if (type === 'message') {
        log(`event ${data?.type || ''}`);
      }
    };
  }, [link, log, toast]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('demo')) {
      connect({
        mode: 'demo', label: 'Demo device · localhost',
        url: `ws://localhost:8787/agent`, code: '123456',
      });
      return;
    }
    const code = params.get('code');
    if (code) {
      const relay = (params.get('relay') || relayDefault).replace(/\/+$/, '');
      setConnecting(true);
      claimPairCode(relay, code)
        .then(({ room, token }) => connect({
          mode: 'cloud', label: `Cloud · room ${code}`,
          url: cloudSocketUrl(relay, room, token, 'controller'), relay, room, token,
        }))
        .catch((e) => {
          // Codes are single use, so refreshing a shared link would otherwise
          // land on an error screen. Reuse the connection we stored the first
          // time the same link worked.
          let saved: Connection | null = null;
          try { saved = JSON.parse(localStorage.getItem('airlock.last') || 'null'); } catch {}
          if (saved?.mode === 'cloud' && saved.relay.replace(/\/+$/, '') === relay && saved.label === `Cloud · room ${code}`) {
            connect(saved);
            return;
          }
          setConnecting(false);
          setErr(e?.message || 'pairing code not found or expired');
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = (c: Connection) => {
    setConnecting(true);
    setErr('');
    setDevice(null);
    setStats({});
    setLogs([]);
    setUnread(0);
    setLast(c);
    try { localStorage.setItem('airlock.last', JSON.stringify(c)); } catch {}
    link.connect(c);
  };

  const disconnect = () => {
    link.disconnect();
    setDevice(null);
    setStats({});
    setNav('overview');
  };

  const online = status === 'online';
  const [title, subtitle] = TITLES[nav] || ['Airlock', ''];

  if (!online && status !== 'reconnecting') {
    return (
      <div style={{ height: '100%', overflow: 'auto' }}>
        <Connect onConnect={connect} busy={connecting} error={err} relayDefault={relayDefault} last={last} />
        <Toasts toasts={toasts} />
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="phone" size={18} /></span>
          <div className="brand-text">
            <div className="brand-name">Airlock</div>
            <div className="brand-sub">device console</div>
          </div>
        </div>

        <div className="nav-label">Workspace</div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={clsx('nav-item', nav === item.id && 'active')}
              title={item.label}
              aria-label={item.label}
              onClick={() => { setNav(item.id); if (item.id === 'notifications') setUnread(0); }}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {item.id === 'notifications' && unread > 0 && <span className="badge">{unread}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="device-mini">
            <div className="avatar"><Icon name="phone" size={17} /></div>
            <div style={{ minWidth: 0 }}>
              <div className="name">{device?.name || 'Device'}</div>
              <div className="sub">{device?.android ? `Android ${device.android}` : device?.id || ''}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={disconnect}>
            <Icon name="logout" size={15} /><span>Disconnect</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h2>{title}</h2>
            <div className="crumbs">{subtitle}</div>
          </div>
          <div className="topbar-right">
            {status === 'reconnecting' && <Pill tone="warn"><span className="dot dot-live" /> reconnecting</Pill>}
            {online && <Pill tone="ok"><span className="dot dot-live" /> live</Pill>}
            {stats.battery !== undefined && (
              <Pill tone={stats.battery > 20 ? 'muted' : 'bad'}>
                <Icon name={stats.charging ? 'spark' : 'battery'} size={13} />
                {stats.battery}%
              </Pill>
            )}
            {stats.uptime !== undefined && (
              <span className="faint mono nowrap" style={{ fontSize: 11 }}>up {formatUptime(stats.uptime)}</span>
            )}
            <div className="avatar" style={{ width: 30, height: 30, borderRadius: 9, background: '#17222f', border: '1px solid #22324a', display: 'grid', placeItems: 'center', color: '#9ec1ff' }}>
              <Icon name="shield" size={15} />
            </div>
          </div>
        </header>

        <main className="content">
          {status === 'reconnecting' && (
            <div className="warn-strip" style={{ marginBottom: 16 }}>
              <Icon name="warning" size={15} />
              <span>Link lost ({detail || 'network'}). Retrying automatically — actions are paused until it returns.</span>
            </div>
          )}

          {nav === 'overview' && (
            <Overview link={link} device={device} stats={stats} logs={logs} onNavigate={setNav} toast={toast} />
          )}
          {nav === 'files' && <Files link={link} toast={toast} />}
          {nav === 'mirror' && <Mirror link={link} toast={toast} />}
          {nav === 'messages' && <Messages link={link} toast={toast} />}
          {nav === 'notifications' && <Notifications link={link} toast={toast} />}
          {nav === 'camera' && <CameraView link={link} toast={toast} />}
          {nav === 'settings' && (
            <Settings link={link} device={device} stats={stats} last={last} onDisconnect={disconnect} toast={toast} />
          )}
        </main>
      </div>

      <Toasts toasts={toasts} />
    </div>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('toast', t.tone === 'ok' ? 'ok' : t.tone === 'bad' ? 'bad' : t.tone === 'warn' ? 'warn' : '')}>
          <Icon name={t.tone === 'ok' ? 'check' : t.tone === 'bad' ? 'warning' : t.tone === 'warn' ? 'warning' : 'spark'} size={15} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
