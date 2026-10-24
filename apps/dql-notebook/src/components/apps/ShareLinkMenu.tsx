import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { api } from '../../api/client';
import { appPageUrl, isLoopbackOrigin } from './app-links';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection copy below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

/**
 * Links to this page (RFC 0008 step 10). A link opens the page in the
 * reader; on a server shared over the network, the network link is
 * read-only (RFC 0010): it opens this App and nothing else, for a limited
 * time, and never carries the server's own access token. Sending the page
 * outside the network is a signed export.
 */
export function ShareLinkMenu({ appId, pageId }: { appId: string; pageId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<{ network: boolean; origins: string[]; viewer?: { token: string; expiresAt: string }; viewerBlocked?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.getShareOrigins(appId).then((result) => { if (alive) setShare(result); });
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      alive = false;
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open, appId]);
  const link = { appId, pageId };
  const here = window.location.origin;
  const local = isLoopbackOrigin(here);
  const rows: Array<{ label: string; url: string }> = [
    { label: local ? 'On this computer' : 'This address', url: appPageUrl(here, link) },
    ...(share?.network && share.viewer
      ? share.origins.filter((origin) => origin !== here).slice(0, 3).map((origin) => ({ label: `Read-only, on your network (${new URL(origin).host})`, url: appPageUrl(origin, link, share.viewer?.token) }))
      : []),
  ];
  const copy = async (url: string) => {
    if (await copyText(url)) {
      setCopied(url);
      window.setTimeout(() => setCopied((current) => (current === url ? null : current)), 2500);
    }
  };
  return (
    <div className="dql-alerts" ref={rootRef}>
      <button type="button" className="dql-export-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)} title="Link to this page">
        <Link2 size={13} aria-hidden="true" /> Share
      </button>
      {open ? (
        <div className="dql-alerts-panel" role="dialog" aria-label="Share this page">
          <h3>Link to this page</h3>
          {rows.map((row) => (
            <div key={row.url} className="dql-share-row">
              <label>{row.label}</label>
              <div className="dql-alerts-row">
                <input readOnly value={row.url} aria-label={row.label} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" className="dql-share-copy" aria-label={`Copy link: ${row.label}`} onClick={() => void copy(row.url)}>
                  {copied === row.url ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied === row.url ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ))}
          {share === null ? <p className="dql-alerts-note">Checking where this page can be opened…</p>
            : share.network
              ? <p className="dql-alerts-note">{share.viewer
                ? `Network links are read-only: they open this App's pages and nothing else in the project, until ${new Date(share.viewer.expiresAt).toLocaleDateString()}. Changing the server token ends every link.`
                : share.viewerBlocked ?? 'This page can be opened on your network only by people who already have the server access link.'}</p>
              : <p className="dql-alerts-note">This link opens only on this computer. To share on your network, start the notebook with <code>--host 0.0.0.0</code> (it needs <code>ZLENS_SERVER_TOKEN</code> and <code>ZLENS_ALLOWED_ORIGINS</code>). To send the page to anyone, use Export → Signed HTML.</p>}
          <p className="dql-alerts-note">The link does not carry your filter choices: anyone else opens the page with its default filters.</p>
        </div>
      ) : null}
    </div>
  );
}
