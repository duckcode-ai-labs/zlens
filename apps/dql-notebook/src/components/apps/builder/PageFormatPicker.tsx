import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileText, LayoutGrid, PanelsTopLeft } from 'lucide-react';

export type PageFormat = 'dashboard' | 'story' | 'canvas';

/**
 * The formats a page can be shown in. Each page has one, chosen by its
 * author; readers see only that one. The stored values stay `story` and
 * `canvas`; authors and readers see Report and Custom layout.
 */
export const PAGE_FORMATS: Array<{ id: PageFormat; label: string; description: string; icon: typeof LayoutGrid }> = [
  { id: 'dashboard', label: 'Dashboard', description: 'A grid of charts and numbers.', icon: LayoutGrid },
  { id: 'story', label: 'Report', description: 'Written findings, with live numbers in the text and charts between paragraphs.', icon: FileText },
  { id: 'canvas', label: 'Custom layout', description: 'Your own layout, designed by you or AI, with the same live data.', icon: PanelsTopLeft },
];

export const pageFormatLabel = (format: PageFormat) => PAGE_FORMATS.find((entry) => entry.id === format)?.label ?? 'Dashboard';

/**
 * "Page style: Dashboard": a setting, not a tab. Changing it changes
 * what readers get, so the menu says so and names every format with what it
 * shows.
 */
export function PageFormatPicker({
  value,
  disabled,
  onChange,
}: {
  value: PageFormat;
  disabled: boolean;
  onChange: (format: PageFormat) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="page-format" ref={rootRef}>
      <button
        type="button"
        className="page-format-button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>Page style:</span>
        <strong>{pageFormatLabel(value)}</strong>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="page-format-menu" role="menu" aria-label="Page style">
          {PAGE_FORMATS.map((format) => {
            const Icon = format.icon;
            const on = format.id === value;
            return (
              <button
                key={format.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={on ? 'on' : undefined}
                onClick={() => { setOpen(false); if (!on) onChange(format.id); }}
              >
                <Icon size={16} aria-hidden="true" />
                <span><strong>{format.label}</strong><small>{format.description}</small></span>
                {on ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <p>Every format shows this page's tiles and numbers. Readers see only the one you choose.</p>
        </div>
      ) : null}
    </div>
  );
}
