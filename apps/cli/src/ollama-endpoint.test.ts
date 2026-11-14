import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { allowedOllamaEndpoint, LOCAL_OLLAMA_ENDPOINT, savedOllamaEndpoint } from './ollama-endpoint.js';

/**
 * The Ollama model routes send a request to Ollama. A request may not choose where that goes (CodeQL
 * js/request-forgery): only Ollama on this computer, or the endpoint saved in the project's settings.
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(embeddings?: Record<string, unknown>): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-ollama-endpoint-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'ollama', defaultConnectionName: 'app', connections: { app: { driver: 'sqlite', filepath: 'main.sqlite' } },
    ...(embeddings ? { ai: { embeddings } } : {}),
  }));
  return projectRoot;
}

describe('allowedOllamaEndpoint', () => {
  it('allows Ollama on this computer and the saved endpoint, and returns the fixed or saved address', () => {
    expect(allowedOllamaEndpoint(undefined, undefined)).toBe(LOCAL_OLLAMA_ENDPOINT);
    expect(allowedOllamaEndpoint('http://localhost:11434/', undefined)).toBe(LOCAL_OLLAMA_ENDPOINT);
    expect(allowedOllamaEndpoint('http://gpu-box.lan:11434', 'http://gpu-box.lan:11434')).toBe('http://gpu-box.lan:11434');
  });

  it('refuses any other address, including cloud metadata and other local ports', () => {
    expect(allowedOllamaEndpoint('http://169.254.169.254', undefined)).toBeUndefined();
    expect(allowedOllamaEndpoint('http://127.0.0.1:3474', undefined)).toBeUndefined();
    expect(allowedOllamaEndpoint('http://gpu-box.lan:11434', 'http://other-box:11434')).toBeUndefined();
    expect(allowedOllamaEndpoint('file:///etc/passwd', undefined)).toBeUndefined();
  });

  it('reads the saved endpoint from the project', () => {
    expect(savedOllamaEndpoint(project({ provider: 'ollama', endpoint: 'http://gpu-box.lan:11434/' }))).toBe('http://gpu-box.lan:11434');
    expect(savedOllamaEndpoint(project())).toBeUndefined();
  });
});

describe('the Ollama routes', () => {
  async function start(projectRoot = project()) {
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      captureServer: (created) => { servers.push(created); },
    });
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
    };
  }

  it('refuses to pull a model from an address that is neither local nor saved', async () => {
    const call = await start();
    const pulled = await call('POST', '/api/settings/embeddings/install', { model: 'nomic-embed-text', endpoint: 'http://169.254.169.254' });
    expect(pulled.status).toBe(400);
    expect(pulled.json.error).toMatch(/Use Ollama on this computer/);
  });

  it('does not list models from such an address', async () => {
    const call = await start();
    const listed = await call('GET', `/api/settings/embeddings/models?endpoint=${encodeURIComponent('http://169.254.169.254')}`);
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({ ollamaReachable: false, installed: [] });
  });
});
