import { useEffect, useRef, useState } from 'react';
import { useHostUi } from '../../host/host-ui';
import { appFilterMemoryStorage, forgetAppFilterMemory } from '../apps/app-filter-memory';

/**
 * Sign-out leaves nothing of this person's App reading behind for the next
 * person on this browser: the App filters it remembered are dropped first.
 */
export function forgetThisPersonsAppFilters(): void {
  const storage = appFilterMemoryStorage();
  if (storage) forgetAppFilterMemory(storage);
}

/**
 * The signed-in person, with the host's links and sign-out (RFC 0010 HH-9).
 * Renders nothing without a host.
 */
export function HostPersonMenu({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const hostUi = useHostUi();
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);

  if (!hostUi.host) return null;
  const name = hostUi.person.name;
  const initials = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
  const menuLinks = hostUi.links.filter((link) => link.placement === 'menu');

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      {hostUi.environment ? (
        <span style={{ font: '500 11px/1 var(--font-mono, "JetBrains Mono", monospace)', padding: '4px 8px', borderRadius: 999, background: 'var(--accent-dim)', color: 'color-mix(in srgb, var(--accent) 80%, var(--text-primary))', whiteSpace: 'nowrap' }}>
          {hostUi.environment}
        </span>
      ) : null}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={hostUi.roleLabel ? `${name} · ${hostUi.roleLabel}` : name}
        onClick={() => setOpen((value) => !value)}
        style={{ width: 28, height: 28, borderRadius: 999, border: 0, background: 'var(--accent)', color: 'var(--accent-fg, #fff)', fontWeight: 600, fontSize: 11, cursor: 'pointer' }}
      >
        {initials}
      </button>
      {open ? (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', minWidth: 220, background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 4, zIndex: 1000, display: 'grid', gap: 1 }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4, display: 'grid' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <strong style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</strong>
              {hostUi.roleLabel ? (
                // The person's role in the host's words (RFC 0010 HH-9 `roleLabel`), e.g. "Steward".
                <span data-testid="host-role-label" style={{ font: '500 11px/1 var(--font-sans, inherit)', padding: '3px 7px', borderRadius: 999, background: 'var(--accent-dim)', color: 'color-mix(in srgb, var(--accent) 80%, var(--text-primary))', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {hostUi.roleLabel}
                </span>
              ) : null}
            </span>
            {hostUi.person.email && hostUi.person.email !== name ? <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{hostUi.person.email}</span> : null}
          </div>
          {menuLinks.map((link) => (
            <a key={link.id} role="menuitem" href={link.href} style={{ display: 'block', padding: '7px 10px', borderRadius: 6, color: 'var(--text-primary)', textDecoration: 'none', fontSize: 13 }}>{link.label}</a>
          ))}
          {hostUi.signOutUrl ? (
            <a role="menuitem" href={hostUi.signOutUrl} onClick={forgetThisPersonsAppFilters} style={{ display: 'block', padding: '7px 10px', borderRadius: 6, color: 'var(--text-primary)', textDecoration: 'none', fontSize: 13 }}>Sign out</a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
