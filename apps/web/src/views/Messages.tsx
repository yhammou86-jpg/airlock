import React, { useEffect, useRef, useState } from 'react';
import { Card, Empty, Icon, Spinner } from '../components/ui';
import type { Link } from '../lib/link';
import type { Toast } from '../App';
import { formatDate } from '../lib/util';

type Thread = { id: string; name: string; address: string; unread: number; preview: string; ts: number };
type Msg = { id: string; from: 'me' | 'them'; body: string; ts: number };

export function Messages({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function loadThreads() {
    try {
      const res = await link.request<any>('sms.threads', {}, 45000);
      const list: Thread[] = res.threads || [];
      setThreads(list);
      if (!active && list.length) openThread(list[0]);
    } catch (e: any) {
      toast(e?.message || 'could not load threads', 'bad');
    } finally {
      setLoading(false);
    }
  }

  async function openThread(t: Thread) {
    setActive(t);
    try {
      const res = await link.request<any>('sms.messages', { threadId: t.id }, 45000);
      setMessages(res.messages || []);
      setThreads((list) => list.map((x) => (x.id === t.id ? { ...x, unread: 0 } : x)));
    } catch (e: any) {
      toast(e?.message || 'could not load messages', 'bad');
    }
  }

  useEffect(() => {
    loadThreads();
    const off = link.subscribeEvent((type, data) => {
      if (type === 'sms' && active && data?.threadId === active.id) {
        setMessages((m) => (m.some((x) => x.id === data.message.id) ? m : [...m, data.message]));
      } else if (type === 'sms') {
        loadThreads();
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!body.trim() || !active) return;
    setSending(true);
    try {
      const res = await link.request<any>('sms.send', { threadId: active.id, to: active.address, body: body.trim() }, 45000);
      setMessages((m) => [...m, res.message]);
      setBody('');
      setThreads((list) => list.map((t) => (t.id === active.id ? { ...t, preview: res.message.body, ts: res.message.ts } : t)));
    } catch (e: any) {
      toast(e?.message || 'send failed', 'bad');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p>SMS is read from and written to the phone's own telephony stack.</p>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={loadThreads}><Icon name="refresh" size={14} /> Refresh</button>
      </div>

      <div className="split">
        <Card title={`Threads · ${threads.length}`}>
          {loading && <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>}
          {!loading && threads.length === 0 && <Empty icon="message" title="No conversations" body="SMS threads appear here once the device grants READ_SMS." />}
          <div className="thread-list">
            {threads.map((t) => (
              <button key={t.id} className={`thread ${active?.id === t.id ? 'active' : ''}`} onClick={() => openThread(t)}>
                <span className="avatar">{(t.name || t.address).slice(0, 1).toUpperCase()}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="t-name">{t.name || t.address} {t.unread > 0 && <span className="badge">{t.unread}</span>}</span>
                  <span className="t-prev">{t.preview}</span>
                </span>
                <span className="t-time">{formatDate(t.ts)}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card
          title={active ? `${active.name || active.address}` : 'Conversation'}
          right={active && <span className="faint mono" style={{ fontSize: 11 }}>{active.address}</span>}
        >
          {!active && <Empty icon="message" title="Pick a conversation" />}
          {active && (
            <div className="chat">
              <div className="chat-head">
                <div className="row">
                  <span className="pill pill-muted"><Icon name="phone" size={12} /> {active.address}</span>
                  <span className="faint" style={{ fontSize: 11 }}>{messages.length} messages</span>
                </div>
              </div>
              <div className="chat-body" ref={bodyRef}>
                {messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.from === 'me' ? 'me' : 'them'}`}>
                    {m.body}
                    <time>{formatDate(m.ts)}</time>
                  </div>
                ))}
                {messages.length === 0 && <span className="faint" style={{ fontSize: 12 }}>No messages in this thread.</span>}
              </div>
              <div className="chat-input">
                <input
                  className="input"
                  placeholder={`Text ${active.name || active.address}…`}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                <button className="btn btn-primary" onClick={send} disabled={sending || !body.trim()}>
                  {sending ? <Spinner size={14} /> : <Icon name="message" size={15} />} Send
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
