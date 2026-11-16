import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Empty, Icon, Spinner, fileIcon } from '../components/ui';
import type { Link } from '../lib/link';
import type { Toast } from '../App';
import { downloadBlob, formatBytes, formatDate, normPath } from '../lib/util';

type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number; kind: string };
type Transfer = { id: string; name: string; dir: 'up' | 'down'; sent: number; total: number; state: 'active' | 'done' | 'error'; error?: string };

export function Files({ link, toast }: { link: Link; toast: (t: string, tone?: Toast['tone']) => void }) {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [drag, setDrag] = useState(false);
  const [modal, setModal] = useState<null | { kind: 'mkdir' | 'rename' | 'delete' | 'preview'; target?: Entry; value?: string }>(null);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (p = path) => {
    setLoading(true);
    try {
      const res = await link.request<any>('fs.list', { path: p });
      setEntries(res.entries || []);
    } catch (e: any) {
      toast(e?.message || 'could not list folder', 'bad');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [link, path, toast]);

  useEffect(() => { refresh(); }, [path]); // eslint-disable-line

  function updateTransfer(id: string, patch: Partial<Transfer>) {
    setTransfers((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function uploadFiles(files: File[]) {
    for (const file of files) {
      const id = Math.random().toString(36).slice(2);
      setTransfers((l) => [{ id, name: file.name, dir: 'up', sent: 0, total: file.size, state: 'active' }, ...l]);
      try {
        const res = await link.upload(path, file, (sent) => updateTransfer(id, { sent }));
        updateTransfer(id, { state: 'done', sent: file.size });
        if (res && res.ok === false) toast(`${file.name}: checksum mismatch`, 'bad');
        else toast(`${file.name} uploaded`, 'ok');
      } catch (e: any) {
        updateTransfer(id, { state: 'error', error: e?.message });
        toast(`${file.name}: ${e?.message || 'upload failed'}`, 'bad');
      }
    }
    refresh();
  }

  async function download(e: Entry) {
    const id = Math.random().toString(36).slice(2);
    setTransfers((l) => [{ id, name: e.name, dir: 'down', sent: 0, total: e.size, state: 'active' }, ...l]);
    try {
      const res = await link.download(e.path, (received) => updateTransfer(id, { sent: received }));
      updateTransfer(id, { state: 'done' });
      downloadBlob(res.blob, res.name);
      toast(`${e.name} downloaded (${formatBytes(res.size)})`, 'ok');
    } catch (err: any) {
      updateTransfer(id, { state: 'error', error: err?.message });
      toast(err?.message || 'download failed', 'bad');
    }
  }

  async function previewImage(e: Entry) {
    try {
      toast('fetching preview…', 'info');
      const res = await link.download(e.path);
      const url = URL.createObjectURL(res.blob);
      setPreview({ url, name: e.name });
    } catch (err: any) {
      toast(err?.message || 'preview failed', 'bad');
    }
  }

  async function submitModal() {
    if (!modal) return;
    const target = modal.target;
    try {
      if (modal.kind === 'mkdir') {
        if (!modal.value?.trim()) return;
        await link.request('fs.mkdir', { path, name: modal.value.trim() });
        toast('folder created', 'ok');
      } else if (modal.kind === 'rename' && target) {
        if (!modal.value?.trim()) return;
        await link.request('fs.rename', { path, name: target.name, newName: modal.value.trim() });
        toast('renamed', 'ok');
      } else if (modal.kind === 'delete' && target) {
        await link.request('fs.delete', { paths: [target.path] });
        toast(`${target.name} deleted`, 'ok');
      }
      setModal(null);
      refresh();
    } catch (e: any) {
      toast(e?.message || 'operation failed', 'bad');
    }
  }

  const shown = entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()));
  const crumbs = path.split('/').filter(Boolean);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Files</h1>
          <p>{entries.length} items · checksummed transfers over the same socket</p>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => refresh()} disabled={loading}>
          {loading ? <Spinner size={13} /> : <Icon name="refresh" size={14} />} Refresh
        </button>
        <button className="btn btn-sm" onClick={() => setModal({ kind: 'mkdir', value: 'New folder' })}>
          <Icon name="plus" size={14} /> New folder
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={14} /> Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => { const f = Array.from(e.target.files || []); e.currentTarget.value = ''; if (f.length) uploadFiles(f); }}
        />
      </div>

      <div className="files-bar">
        <div className="crumbs">
          <button onClick={() => setPath('/')}><Icon name="folder" size={13} /></button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span className="sep">/</span>
              <button onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </React.Fragment>
          ))}
          {crumbs.length === 0 && <span className="faint">/</span>}
        </div>
        <div className="spacer grow" />
        <div className="row" style={{ maxWidth: 240, width: '100%' }}>
          <Icon name="search" size={15} className="faint" />
          <input className="input" style={{ padding: '7px 10px' }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>

      <div className="file-table">
        <div className="file-row head">
          <span>Name</span><span>Size</span><span>Modified</span><span />
        </div>
        {loading && (
          <div style={{ padding: 36, textAlign: 'center' }}><Spinner size={22} /></div>
        )}
        {!loading && shown.length === 0 && (
          <Empty
            icon="folder"
            title={filter ? 'Nothing matches that filter' : 'This folder is empty'}
            body={filter ? 'Clear the search box to see everything here.' : 'Drop files anywhere below to upload them.'}
          />
        )}
        {!loading && shown.map((e) => (
          <div className="file-row" key={e.path} onDoubleClick={() => { if (e.dir) setPath(e.path); else if (e.kind === 'image') previewImage(e); }}>
            <div className="file-name">
              <span className={`file-ico ${e.dir ? 'folder' : ''}`}><Icon name={fileIcon(e.kind, e.dir)} size={15} /></span>
              <button onClick={() => (e.dir ? setPath(e.path) : e.kind === 'image' ? previewImage(e) : download(e))}>
                {e.name}
              </button>
            </div>
            <span className="faint mono">{e.dir ? '—' : formatBytes(e.size)}</span>
            <span className="faint mono">{formatDate(e.mtime)}</span>
            <div className="file-actions">
              {!e.dir && (
                <button className="btn btn-ghost btn-icon" title="Download" onClick={() => download(e)}>
                  <Icon name="download" size={14} />
                </button>
              )}
              <button className="btn btn-ghost btn-icon" title="Rename" onClick={() => setModal({ kind: 'rename', target: e, value: e.name })}>
                <Icon name="file" size={14} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Delete" onClick={() => setModal({ kind: 'delete', target: e })}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div
        className={`drop-zone ${drag ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = Array.from(e.dataTransfer.files || []);
          if (f.length) uploadFiles(f);
        }}
      >
        <Icon name="upload" size={20} />
        <div style={{ marginTop: 6 }}>Drop files here to upload into <span className="mono">{path}</span></div>
      </div>

      {transfers.length > 0 && (
        <Card title="Transfers" right={
          <button className="btn btn-ghost btn-sm" onClick={() => setTransfers([])}>Clear</button>
        }>
          {transfers.map((t) => (
            <div className="transfer" key={t.id}>
              <div className="row">
                <span className="name"><Icon name={t.dir === 'up' ? 'upload' : 'download'} size={12} /> {t.name}</span>
                <span className="faint mono">
                  {t.state === 'error' ? t.error : t.state === 'done' ? 'done' : `${formatBytes(t.sent)} / ${formatBytes(t.total)}`}
                </span>
              </div>
              <div className="progress">
                <div
                  className={`progress-fill ${t.state === 'error' ? 'progress-bad' : t.state === 'done' ? 'progress-ok' : 'progress-accent'}`}
                  style={{ width: `${t.total ? Math.min(100, (t.sent / t.total) * 100) : t.state === 'done' ? 100 : 4}%` }}
                />
              </div>
            </div>
          ))}
        </Card>
      )}

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {modal.kind === 'mkdir' ? 'New folder' : modal.kind === 'rename' ? 'Rename' : 'Delete item'}
            </h3>
            {modal.kind === 'delete' ? (
              <p className="muted" style={{ margin: 0 }}>
                Delete <b style={{ color: 'var(--text)' }}>{modal.target?.name}</b> permanently on the device?
              </p>
            ) : (
              <input
                className="input"
                autoFocus
                value={modal.value || ''}
                onChange={(e) => setModal({ ...modal, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') submitModal(); }}
              />
            )}
            <div className="actions">
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className={`btn ${modal.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} onClick={submitModal}>
                {modal.kind === 'delete' ? 'Delete' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-back" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>
          <div style={{ maxWidth: '86vw', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <img src={preview.url} alt={preview.name} style={{ maxWidth: '86vw', maxHeight: '78vh', borderRadius: 12, border: '1px solid var(--line-2)' }} />
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <span className="mono faint">{preview.name}</span>
              <button className="btn btn-sm" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>
                <Icon name="x" size={14} /> Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
