import React, { useState } from 'react';
import { Card, Icon, Pill, Progress } from '../components/ui';
import type { Link, DeviceInfo, Stats } from '../lib/link';
import type { LogEntry, Toast } from '../App';
import { formatBytes, formatDate, formatUptime, pct } from '../lib/util';

type Props = {
  link: Link;
  device: DeviceInfo | null;
  stats: Stats;
  logs: LogEntry[];
  onNavigate: (id: string) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
};

export function Overview({ link, device, stats, logs, onNavigate, toast }: Props) {
  const [busy, setBusy] = useState('');

  async function act(action: string, value?: any) {
    setBusy(action);
    try {
      const r = await link.request('device.action', { action, value });
      toast(`${action.replace('.', ' ')} sent`, 'ok');
      return r;
    } catch (e: any) {
      toast(e?.message || `${action} failed`, 'bad');
    } finally {
      setBusy('');
    }
  }

  const storagePct = pct(stats.storage?.used, stats.storage?.total);
  const memPct = pct(
    stats.mem ? stats.mem.total - stats.mem.free : 0,
    stats.mem?.total,
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{device?.name || 'Your device'}</h1>
          <p>
            {device?.model || 'Android'} · agent {device?.agent || '—'} ·{' '}
            <span className="mono">{device?.ip || stats.network?.ip || '—'}</span>
          </p>
        </div>
        <div className="spacer" />
        <Pill tone="ok"><span className="dot dot-live" /> connected</Pill>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label"><Icon name="battery" size={14} /> Battery</div>
          <div className="stat-value">{stats.battery ?? '—'}<small>%</small></div>
          <div className="stat-sub">{stats.charging ? 'charging' : 'on battery'} · {stats.battery && stats.battery > 20 ? 'healthy' : 'low'}</div>
          <div style={{ marginTop: 9 }}><Progress value={stats.battery ?? 0} tone={(stats.battery ?? 0) > 40 ? 'ok' : (stats.battery ?? 0) > 15 ? 'warn' : 'bad'} /></div>
        </div>

        <div className="stat">
          <div className="stat-label"><Icon name="folder" size={14} /> Storage</div>
          <div className="stat-value">{formatBytes(stats.storage?.free)}<small>free</small></div>
          <div className="stat-sub">{formatBytes(stats.storage?.used)} of {formatBytes(stats.storage?.total)} used</div>
          <div style={{ marginTop: 9 }}><Progress value={storagePct} tone={storagePct > 88 ? 'bad' : storagePct > 70 ? 'warn' : 'accent'} /></div>
        </div>

        <div className="stat">
          <div className="stat-label"><Icon name="spark" size={14} /> CPU</div>
          <div className="stat-value">{stats.cpu ?? '—'}<small>%</small></div>
          <div className="stat-sub">8 cores · {formatUptime(stats.uptime)} uptime</div>
          <div style={{ marginTop: 9 }}><Progress value={stats.cpu ?? 0} tone={(stats.cpu ?? 0) > 80 ? 'bad' : 'accent'} /></div>
        </div>

        <div className="stat">
          <div className="stat-label"><Icon name="cloud" size={14} /> Memory</div>
          <div className="stat-value">{stats.mem ? formatBytes(stats.mem.total - stats.mem.free) : '—'}</div>
          <div className="stat-sub">of {formatBytes(stats.mem?.total)} · {memPct}% used</div>
          <div style={{ marginTop: 9 }}><Progress value={memPct} tone={memPct > 85 ? 'warn' : 'ok'} /></div>
        </div>
      </div>

      <div className="overview-grid">
        <Card title="Quick actions" right={<span className="faint" style={{ fontSize: 11 }}>sent over the live link</span>}>
          <div className="quick-grid">
            {[
              ['wake', 'sun', 'Wake screen'],
              ['lock', 'lock', 'Lock screen'],
              ['flashlight', 'star', 'Flashlight'],
              ['media.play', 'play', 'Play media'],
              ['media.pause', 'pause', 'Pause media'],
              ['find', 'bell', 'Find phone'],
            ].map(([action, icon, label]) => (
              <button key={action} className="quick" onClick={() => act(action)} disabled={!!busy}>
                <Icon name={icon} size={18} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="row mt-16">
            <button className="btn btn-sm" onClick={() => onNavigate('mirror')}>
              <Icon name="mirror" size={14} /> Mirror screen
            </button>
            <button className="btn btn-sm" onClick={() => onNavigate('files')}>
              <Icon name="folder" size={14} /> Open files
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                const r = await act('clipboard.get');
                if (r?.text) {
                  try {
                    await navigator.clipboard.writeText(r.text);
                    toast('Phone clipboard copied to this computer', 'ok');
                  } catch {
                    toast(`Phone clipboard: ${r.text}`, 'info');
                  }
                }
              }}
            >
              <Icon name="clipboard" size={14} /> Copy phone clipboard
            </button>
          </div>

          <div className="mt-24">
            <div className="card-head"><h3>Activity</h3><span className="faint" style={{ fontSize: 11 }}>{logs.length} events</span></div>
            <div className="activity">
              {logs.length === 0 && <span className="faint" style={{ fontSize: 12 }}>No activity yet. Interactions and device events show up here.</span>}
              {logs.slice(0, 12).map((l) => (
                <div className="activity-row" key={l.id}>
                  <time>{new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <span className="ico">
                    <Icon name={l.level === 'error' ? 'warning' : l.level === 'warn' ? 'warning' : 'check'} size={12} />
                  </span>
                  <span className={l.level === 'error' ? 'pill-bad' : l.level === 'warn' ? 'pill-warn' : ''}>{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card title="Device">
            <div className="kv"><span>Model</span><span>{device?.model || '—'}</span></div>
            <div className="kv"><span>Android</span><span>{device?.android || '—'}</span></div>
            <div className="kv"><span>Agent</span><span>{device?.agent || '—'}</span></div>
            <div className="kv"><span>Device ID</span><span className="truncate" style={{ maxWidth: 170 }}>{device?.id || '—'}</span></div>
            <div className="kv"><span>Network</span><span>{stats.network?.ssid || stats.network?.type || '—'}</span></div>
            <div className="kv"><span>Address</span><span>{device?.ip || stats.network?.ip || '—'}{device?.port ? `:${device.port}` : ''}</span></div>
            <div className="kv"><span>Uptime</span><span>{formatUptime(stats.uptime)}</span></div>
            <div className="kv"><span>Volume</span><span>{stats.muted ? 'muted' : `${stats.volume ?? '—'} / 15`}</span></div>
            <div className="kv"><span>Last event</span><span>{formatDate(logs[0]?.ts)}</span></div>
          </Card>
        </div>
      </div>
    </div>
  );
}
