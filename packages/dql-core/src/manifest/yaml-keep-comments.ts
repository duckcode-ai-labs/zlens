import * as jsYaml from 'js-yaml';
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';

/**
 * Write `next` over the YAML file `before` as a person would edit it by hand:
 * comments, key order and the quoting of every value left alone stay as they
 * were, and only what changed is rewritten. A list of objects with an `id`
 * keeps each entry's comments by id, wherever it moves.
 *
 * The result must read back as exactly `next` (js-yaml, the reader every
 * modeling file goes through). When it does not, or `before` is not one
 * readable mapping, `fallback(next)` is written instead: comments are lost
 * there, never data.
 */
export function yamlKeepingComments(before: string, next: unknown, fallback: (value: unknown) => string): string {
  if (!before.trim() || !isPlainObject(next)) return fallback(next);
  let doc: Document;
  try {
    // Timestamps as js-yaml reads them, so a date-like string is written quoted and reads back a string.
    doc = parseDocument(before, { customTags: ['timestamp'] });
  } catch {
    return fallback(next);
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return fallback(next);
  try {
    doc.contents = merged(doc, doc.contents, next) as typeof doc.contents;
    const text = doc.toString({ lineWidth: 0 });
    return sameValue(jsYaml.load(text), next) ? text : fallback(next);
  } catch {
    return fallback(next);
  }
}

function merged(doc: Document, node: unknown, value: unknown): Node {
  if (isPlainObject(value) && isMap(node)) {
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (value[key] === undefined) node.delete(pair.key);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const existing = node.get(key, true);
      node.set(key, existing === undefined ? doc.createNode(item) : merged(doc, existing, item));
    }
    return node;
  }
  if (Array.isArray(value) && isSeq(node)) {
    const idOf = (item: unknown): string | undefined => (isPlainObject(item) && typeof item.id === 'string' ? item.id : undefined);
    const byId = new Map<string, unknown>();
    for (const item of node.items) {
      const id = isMap(item) ? item.get('id') : undefined;
      if (typeof id === 'string' && !byId.has(id)) byId.set(id, item);
    }
    const byIdentity = value.length > 0 && value.every((item) => idOf(item) !== undefined);
    node.items = value.map((item, index) => {
      const existing = byIdentity ? byId.get(idOf(item)!) : node.items[index];
      return existing === undefined ? doc.createNode(item) : merged(doc, existing, item);
    });
    return node;
  }
  if (isScalar(node) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
    if (node.value !== value) node.value = value;
    return node;
  }
  // A value that changed kind (a scalar became a list): new node, the old one's comments carried.
  const created = doc.createNode(value) as Node;
  if (node && typeof node === 'object') {
    const old = node as { comment?: string | null; commentBefore?: string | null };
    if (old.comment) created.comment = old.comment;
    if (old.commentBefore) created.commentBefore = old.commentBefore;
  }
  return created;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const other = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === other.length && keys.every((key) => sameValue(a[key], b[key]));
  }
  return a === b;
}
