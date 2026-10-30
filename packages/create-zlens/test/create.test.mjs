import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseFolder, parseCreateArgs, whatIsHere } from '../bin/create-zlens.mjs';

const folder = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'create-zlens-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};

test('the first word is the folder; everything else goes to zlens notebook', () => {
  assert.deepEqual(parseCreateArgs(['shop']), { help: false, folder: 'shop', passThrough: [] });
  assert.deepEqual(parseCreateArgs(['shop', '--', '--port', '4000']), { help: false, folder: 'shop', passThrough: ['--port', '4000'] });
  assert.deepEqual(parseCreateArgs(['--port', '4000']), { help: false, folder: null, passThrough: ['--port', '4000'] });
  assert.deepEqual(parseCreateArgs([]), { help: false, folder: null, passThrough: [] });
  assert.equal(parseCreateArgs(['--help']).help, true);
});

test('an empty folder gets a new project folder; asked in a terminal', async () => {
  const dir = folder();
  try {
    assert.equal(await whatIsHere(dir), null);
    assert.equal(await chooseFolder({ cwd: dir, interactive: false }), 'my-analytics');
    let asked = '';
    const answer = await chooseFolder({ cwd: dir, interactive: true, ask: async (question) => { asked = question; return ''; } });
    assert.equal(answer, 'my-analytics');
    assert.match(asked, /Project folder \(my-analytics\)/);
    assert.equal(await chooseFolder({ cwd: dir, interactive: true, ask: async () => 'sales  ' }), 'sales');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder with data or a project is used where it is', async () => {
  const withDb = folder({ 'shop.duckdb': '' });
  const withProject = folder({ 'dql.config.json': '{}' });
  const withCsv = folder({ 'data/orders.csv': 'id,amount\n1,10\n' });
  try {
    assert.equal(await chooseFolder({ cwd: withDb, interactive: false }), '.');
    assert.equal(await whatIsHere(withProject), 'a ZLens project');
    assert.equal(await chooseFolder({ cwd: withProject, interactive: false }), '.');
    assert.equal(await whatIsHere(withCsv), '1 data file in data/: orders.csv');
    let asked = '';
    assert.equal(await chooseFolder({ cwd: withDb, interactive: true, ask: async (question) => { asked = question; return ''; } }), '.');
    assert.match(asked, /Found the database shop\.duckdb here/);
  } finally {
    for (const dir of [withDb, withProject, withCsv]) rmSync(dir, { recursive: true, force: true });
  }
});
