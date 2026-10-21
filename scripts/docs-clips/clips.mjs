// The feature clips the docs embed. The ids are a contract with the docs pages
// (docs/media/clips/<id>.{mp4,webm,png}); docs/media/clips/clips.yml carries
// each clip's title, caption and steps.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIPS_DIR = join(ROOT, 'docs', 'media', 'clips');
export const JOURNEYS_DIR = join(ROOT, 'apps', 'dql-notebook', 'browser', 'clips');

export const CLIP_IDS = [
  'overview',
  'quickstart',
  'ask-certified',
  'ask-review',
  'ask-refusal',
  'import-certify',
  'notebook',
  'app-ask',
  'app-builder',
  'lineage',
  'mcp-connect',
];

/** Clips that also get an optimized GIF (the README one). */
export const GIF_IDS = ['overview'];

const MB = 1024 * 1024;

/**
 * Size budget per file. The docs load a clip's MP4 or WebM (never both) plus
 * its poster; the README loads the GIF.
 */
export function budgetFor(id, ext) {
  const long = id === 'overview';
  switch (ext) {
    case 'mp4':
    case 'webm':
      return long ? 3 * MB : 2 * MB;
    case 'png':
      return 0.5 * MB;
    case 'gif':
      return 5 * MB;
    default:
      return 0;
  }
}

/** Target the encoder aims under, leaving headroom below the hard budget. */
export function targetFor(id, ext) {
  return Math.round(budgetFor(id, ext) * 0.8);
}
