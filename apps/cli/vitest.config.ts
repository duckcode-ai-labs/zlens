import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@zlens/core/format",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/format/index.ts",
        ),
      },
      {
        find: "@zlens/core/lineage",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/lineage/index.ts",
        ),
      },
      {
        find: "@zlens/core/artifacts",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/artifacts/index.ts",
        ),
      },
      // Node-only Dataset authoring helpers must stay outside the browser-safe
      // core barrel. Keep these exact subpaths ahead of the broad core alias so
      // integration tests exercise their TypeScript sources rather than trying
      // to append a path to `src/index.ts`.
      {
        find: "@zlens/core/datasets/aggregate-expression.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/aggregate-expression.node.ts",
        ),
      },
      {
        find: "@zlens/core/datasets/source-authoring.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/source-authoring.node.ts",
        ),
      },
      {
        find: "@zlens/core/datasets/component-proof.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/component-proof.node.ts",
        ),
      },
      // Browser-safe subpaths the App Studio's planners import (a test loads
      // one of them by path to exercise the same code the browser runs).
      {
        find: /^@zlens\/core\/(datasets|apps)\/([a-z-]+)$/,
        replacement: resolve(__dirname, "../../packages/dql-core/src/$1/$2.ts"),
      },
      {
        find: "@zlens/core",
        replacement: resolve(__dirname, "../../packages/dql-core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    // CLI integration tests start real local servers and exercise filesystem/package workflows.
    testTimeout: 30_000,
    // The suite reaches nothing beyond this machine: no check for the latest release on the npm registry, and a
    // connector driver install (a server started on a project whose connection needs one) uses npm's cache only,
    // against a registry on loopback that answers nothing.
    env: {
      ZLENS_DISABLE_VERSION_CHECK: '1',
      npm_config_offline: 'true',
      npm_config_registry: 'http://127.0.0.1:9/',
    },
  },
});
