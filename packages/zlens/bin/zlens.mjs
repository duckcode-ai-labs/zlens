#!/usr/bin/env node
// `npx zlens …` with nothing installed. npx runs a package's only command, and
// @zlens/cli has two (`zlens` and its old name `dql`), so `npx @zlens/cli` stops
// with "could not determine executable to run". This package has one, and runs
// exactly what @zlens/cli's `zlens` runs.
await import('@zlens/cli/dist/index.js');
