/**
 * Just enough XML to read a Tableau workbook: elements, attributes and text,
 * with entities decoded. No namespaces, DTDs or validation; comments,
 * processing instructions and CDATA are handled.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
  parent: XmlElement | null;
}

export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '', parent: null };
  let current = root;
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:'[^']*'|"[^"]*"))*)\s*(\/?)>/y;
  // Each closer is looked for going forward, and only once when there is none: a file of `<?` stays linear.
  const closers = new Map<string, number>();
  const closerAfter = (closer: string, from: number): number => {
    const known = closers.get(closer);
    if (known === -1 || (known !== undefined && known >= from)) return known;
    const found = source.indexOf(closer, from);
    closers.set(closer, found);
    return found;
  };
  let last = 0;
  let at = 0;
  while ((at = source.indexOf('<', at)) >= 0) {
    const skipped: Array<[string, string]> = [['<!--', '-->'], ['<?', '?>'], ['<!DOCTYPE', '>']];
    const skip = skipped.find(([opener]) => source.startsWith(opener, at));
    const cdata = source.startsWith('<![CDATA[', at);
    if (skip || cdata) {
      const closer = cdata ? ']]>' : skip![1];
      const end = closerAfter(closer, at);
      if (end < 0) {
        at += 1;
        continue;
      }
      if (at > last) current.text += decodeEntities(source.slice(last, at));
      if (cdata) current.text += source.slice(at + 9, end);
      at = end + closer.length;
      last = at;
      continue;
    }
    tag.lastIndex = at;
    const match = tag.exec(source);
    if (!match) {
      at += 1;
      continue;
    }
    if (at > last) current.text += decodeEntities(source.slice(last, at));
    at += match[0].length;
    last = at;
    if (match[1] === '/') {
      if (current.parent) current = current.parent;
      continue;
    }
    const element: XmlElement = { name: match[2], attributes: parseAttributes(match[3] ?? ''), children: [], text: '', parent: current };
    current.children.push(element);
    if (match[4] !== '/') current = element;
  }
  return root;
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attribute = /([\w:.-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(text))) attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
  return attributes;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const point = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
  });
}

/** Every element under `element` (depth first) whose name is `name`. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack = [...element.children].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    if (next.name === name) found.push(next);
    for (let index = next.children.length - 1; index >= 0; index -= 1) stack.push(next.children[index]);
  }
  return found;
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((item) => item.name === name);
}
