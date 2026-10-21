import type { Domain } from '../../store/types';

export function blockGitPath(domains: Domain[], domainId: string, folderPath: string, slug: string): string {
  const folder = folderPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const suffix = `${folder ? `${folder}/` : ''}${slug}.dql`;
  if (!domainId) return `blocks/${suffix}`;
  const domain = domains.find((item) => item.id === domainId);
  const packageRoot = domain?.sourcePath?.replace(/\/domain\.dql$/, '');
  return packageRoot
    ? `${packageRoot}/blocks/${suffix}`
    : `blocks/${domainId}/${suffix}`;
}

/**
 * Where Save as Block writes a cell's block. The server keeps underscores in
 * the name's slug and places a block with a declared domain inside that
 * domain's package (`domains/<domain>/blocks/`), so a preview built from the
 * dialog's own hyphenated slug under `blocks/<domain>/` named a file that never
 * appeared.
 */
export function savedBlockGitPath(domains: Domain[], domain: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'block';
  const domainId = domain.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^\/+|\/+$/g, '');
  return blockGitPath(domains, domainId, '', slug);
}

/**
 * The file name the server gives a new notebook. The server turns every run of
 * characters other than letters and digits into one underscore, so a hint
 * built from the dialog's hyphenated slug named a file that never appeared.
 */
export function notebookFileStem(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'notebook';
}
