import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every browser module import is present and served by the application', async () => {
  const publicDir = path.join(root, 'public');
  const server = await readFile(path.join(root, 'server.mjs'), 'utf8');
  const scripts = (await readdir(publicDir)).filter((name) => name.endsWith('.js'));
  const required = new Set(['app.js']);

  for (const script of scripts) {
    const source = await readFile(path.join(publicDir, script), 'utf8');
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+\.js)['"]/g)) required.add(match[1]);
  }

  for (const asset of required) {
    assert.ok(scripts.includes(asset), `${asset} is imported but missing from public/`);
    assert.match(server, new RegExp(`['"]/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`), `${asset} is not served by server.mjs`);
  }
});

test('import and export keep their action docks visible while the page scrolls', async () => {
  const [dryRun, exporter, presets, style] = await Promise.all([
    readFile(path.join(root, 'public', 'dry-run.js'), 'utf8'),
    readFile(path.join(root, 'public', 'export.js'), 'utf8'),
    readFile(path.join(root, 'public', 'presets.js'), 'utf8'),
    readFile(path.join(root, 'public', 'style.css'), 'utf8')
  ]);
  assert.match(dryRun, /panel\.append\(importDock\)/, 'import dock must live outside the collapsible details element');
  assert.match(dryRun, /for\(const id of \['runDry','saveImportPreset','runWet'\]\)importDock\.append/, 'import dock must move the real action buttons');
  assert.doesNotMatch(dryRun, /runDryTop|runWetTop|saveImportPresetTop/, 'import dock must not duplicate action buttons');
  assert.match(exporter, /top-export-actions/);
  assert.match(presets, /export-preset-dock/, 'export mapping must have a floating action dock before export starts');
  assert.match(presets, /dock\.append\(\$\('viewPreset'\),\$\('savePreset'\),\$\('openExport'\)\)/, 'export dock must move the real action buttons');
  assert.doesNotMatch(presets, /exportPresetDockEdit|exportPresetDockSave|exportPresetDockContinue/, 'export dock must not duplicate action buttons');
  assert.match(style, /@media\(min-width:901px\)[\s\S]*position:fixed/);
  assert.match(style, /top-import-actions[\s\S]*top-export-actions/);
  assert.match(style, /Approved Bridge visual system/);
  assert.match(style, /bottom:14px/);
});
