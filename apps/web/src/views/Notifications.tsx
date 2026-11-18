import React, { useEffect, useState } from 'react';
import { Card, Empty, Icon, Spinner } from '../components/ui';
import type { Link } from '../lib/link';
import type { Toast } from '../App';
import { formatDate } from '../lib/util';

type Notification = { id: string; app: string; title: string; body: string; ts: number; canReply: boolean };

export function Notifications({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  async function load() {
    try {
      const res = await link.request<any>('notif.list', {}, 45000);
      setItems(res.notifications || []);
    } catch (e: any) {
      toast(e?.message || 'could not load notifications', 'bad');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = link.subscribeEvent((type) => { if (type === 'notif') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  async function dismiss(id: string) {
    try {
      await link.request('notif.dismiss', { id });
      setItems((l) => l.filter((n) => n.id !== id));
    } catch (e: any) {
      toast(e?.message || 'dismiss failed', 'bad');
    }
  }

  async function sendReply(n: Notification) {
    if (!reply.trim()) return;
    try {
      await link.request('notif.reply', { id: n.id, text: reply.trim() });
      toast(`reply sent to ${n.app}`, 'ok');
      setReply('');
      setReplyFor(null);
    } catch (e: any) {
      toast(e?.message || 'reply failed', 'bad');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p>Mirrored from the device's notification listener, with inline replies where the app supports them.</p>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={load}><Icon name="refresh" size={14} /> Refresh</button>
      </div>

      {link.device?.permissions?.notifications === false && (
        <div className="warn-strip" style={{ marginBottom: 14 }}>
          <Icon name="warning" size={15} />
          <span>Notification access is off on the phone, so the feed cannot sync.</span>
          <button
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              try {
                await link.request('device.permission', { permission: 'notification_access' });
                toast('settings opened on the phone', 'ok');
              } catch (e: any) {
                toast(e?.message || 'open Airlock → Permissions on the phone', 'warn');
              }
            }}
          >
            Enable
          </button>
        </div>
      )}

      <Card title={`Feed · ${items.length}`}>
        {loading && <div style={{ padding: 24, textAlign: 'center' }}><Spinner /></div>}
        {!loading && items.length === 0 && (
          <Empty icon="bell" title="No notifications" body="Grant notification access on the phone; new posts stream in live." />
        )}
        <div className="notif-list">
          {items.map((n) => (
            <div className="notif" key={n.id}>
              <div className="app-ico">{n.app.slice(0, 1)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="n-title">{n.title}</div>
                <div className="n-body">{n.body}</div>
                <div className="n-meta">{n.app} · {formatDate(n.ts)}</div>
                {replyFor === n.id && (
                  <div className="reply-row">
                    <input
                      className="input"
                      autoFocus
                      style={{ padding: '7px 10px' }}
                      placeholder="Quick reply…"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendReply(n); }}
                    />
                    <button className="btn btn-primary btn-sm" onClick={() => sendReply(n)}>Send</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setReplyFor(null)}><Icon name="x" size={13} /></button>
                  </div>
                )}
              </div>
              <div className="n-actions">
                {n.canReply && (
                  <button className="btn btn-ghost btn-icon" title="Reply" onClick={() => { setReplyFor(n.id); setReply(''); }}>
                    <Icon name="message" size={14} />
                  </button>
                )}
                <button className="btn btn-ghost btn-icon" title="Dismiss" onClick={() => dismiss(n.id)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
