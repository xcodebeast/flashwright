#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Flashwright: writes the hard forks in vendor/ from their upstream npm packages.
//
//   node utils/vendor/vendor.mjs            # every recipe
//   node utils/vendor/vendor.mjs zod open   # some of them
//
// For each recipe in recipes.mjs it downloads the pinned upstream tarball, applies the
// recipe's patches (each must match exactly once), then copies only the files reachable
// from the recipe's entry points, with the package's license. Helper packages listed in
// `inline` are fetched the same way into deps/<name>, and imports of them are rewritten to
// relative paths. To update a fork, change its versions in recipes.mjs and run this again.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { builtinModules } from 'node:module';

import { recipes } from './recipes.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = path.join(ROOT, 'vendor');
const BUILTINS = new Set(builtinModules);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flashwright-vendor-'));
const tarballs = new Map();

try {
  const names = process.argv.slice(2);
  for (const name of names) {
    if (!recipes[name])
      throw new Error(`No recipe named ${name}`);
  }
  const summaries = [];
  for (const [name, recipe] of Object.entries(recipes)) {
    if (names.length && !names.includes(name))
      continue;
    summaries.push(vendorRecipe(name, recipe));
  }
  writeAliases();
  for (const s of summaries)
    console.log(`${s.name}: kept ${s.keptFiles} of ${s.totalFiles} files, ${kb(s.keptBytes)} of ${kb(s.totalBytes)} of code` + (s.external.size ? `; imports ${[...s.external].sort().join(', ')}` : ''));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// vendor/aliases.json: what the build resolves to the forks.
function writeAliases() {
  const aliases = {};
  for (const [name, recipe] of Object.entries(recipes)) {
    for (const [specifier, target] of Object.entries(recipe.aliases ?? {}))
      aliases[specifier] = path.posix.join(recipe.dir ?? name, target);
  }
  fs.writeFileSync(path.join(VENDOR, 'aliases.json'), JSON.stringify(aliases, null, 2) + '\n');
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function unpack(spec) {
  if (tarballs.has(spec))
    return tarballs.get(spec);
  const dir = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  const file = execFileSync('npm', ['pack', spec, '--pack-destination', dir, '--silent'], { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', path.join(dir, file), '-C', dir]);
  const packageDir = path.join(dir, 'package');
  tarballs.set(spec, packageDir);
  return packageDir;
}

function vendorRecipe(name, recipe) {
  const outDir = path.join(VENDOR, recipe.dir ?? name);
  fs.rmSync(outDir, { recursive: true, force: true });
  const summary = { name, keptFiles: 0, totalFiles: 0, keptBytes: 0, totalBytes: 0, external: new Set() };
  writePackage({ spec: `${recipe.package}@${recipe.version}`, outDir, depsDir: path.join(outDir, 'deps'), recipe, summary, isRoot: true });
  return summary;
}

// Copies one package (the recipe's own, or one of its inlined helpers) into outDir.
function writePackage({ spec, outDir, depsDir, recipe, summary, isRoot }) {
  const sourceDir = unpack(spec);
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  const files = new Map();
  const read = rel => {
    if (!files.has(rel))
      files.set(rel, fs.readFileSync(path.join(sourceDir, rel), 'utf8'));
    return files.get(rel);
  };

  const patches = (isRoot ? recipe.patches : recipe.inlinePatches?.[pkg.name]) ?? {};
  for (const [file, replacements] of Object.entries(patches)) {
    let text = read(file);
    for (const [from, to] of replacements) {
      const count = text.split(from).length - 1;
      if (count !== 1)
        throw new Error(`${pkg.name}: patch for ${file} matched ${count} times:\n${from}`);
      text = text.replace(from, to);
    }
    files.set(file, text);
  }

  const entries = isRoot ? recipe.entries : [packageEntry(sourceDir, pkg)];
  const types = isRoot ? (recipe.types ?? []) : [];
  const reachable = new Set();
  const inlined = new Map();
  const visit = (rel, isTypes) => {
    if (reachable.has(rel))
      return;
    if (!fs.existsSync(path.join(sourceDir, rel)))
      throw new Error(`${pkg.name}: ${rel} does not exist`);
    reachable.add(rel);
    let text = read(rel);
    const comments = commentRanges(text);
    text = text.replace(/((?:\bfrom|\bimport|\brequire\(|\bimport\()\s*)(['"])([^'"]+)\2/g, (match, prefix, quote, specifier, offset) => {
      if (comments.some(([start, end]) => offset >= start && offset < end))
        return match;
      if (specifier.startsWith('.')) {
        visit(resolveRelative(sourceDir, rel, specifier, isTypes), isTypes);
        return match;
      }
      const bare = bareName(specifier);
      if (recipe.inline?.[bare]) {
        if (specifier !== bare)
          throw new Error(`${pkg.name}: ${rel} imports ${specifier}; only the entry of an inlined package is supported`);
        const version = recipe.inline[bare];
        const depDir = path.join(depsDir, bare);
        if (!inlined.has(bare))
          inlined.set(bare, writePackage({ spec: `${bare}@${version}`, outDir: depDir, depsDir, recipe, summary, isRoot: false }));
        const target = path.relative(path.dirname(path.join(outDir, rel)), path.join(depDir, inlined.get(bare)));
        return `${prefix}${quote}${target.startsWith('.') ? target : './' + target}${quote}`;
      }
      if (!isTypes && /^[@a-z0-9]/i.test(specifier) && !specifier.startsWith('node:') && !BUILTINS.has(bare))
        summary.external.add(specifier);
      return match;
    });
    files.set(rel, text);
  };
  for (const entry of entries)
    visit(entry, false);
  for (const entry of types)
    visit(entry, true);

  for (const rel of listFiles(sourceDir)) {
    if (!/\.(c|m)?js$/.test(rel))
      continue;
    const size = fs.statSync(path.join(sourceDir, rel)).size;
    summary.totalFiles++;
    summary.totalBytes += size;
    if (reachable.has(rel)) {
      summary.keptFiles++;
      summary.keptBytes += Buffer.byteLength(files.get(rel));
    }
  }

  for (const rel of isRoot ? recipe.files ?? [] : []) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, rel), path.join(outDir, rel));
  }
  for (const rel of reachable) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), files.get(rel));
  }
  const license = fs.readdirSync(sourceDir).find(f => /^(license|licence|copying)(\.|$)/i.test(f));
  if (!license)
    throw new Error(`${pkg.name}: no license file`);
  fs.copyFileSync(path.join(sourceDir, license), path.join(outDir, license));
  const mainEntry = packageEntry(sourceDir, pkg);
  const entry = reachable.has(mainEntry) ? mainEntry : undefined;
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    description: isRoot ? `Flashwright's hard fork of ${pkg.name}: only the parts Flashwright uses. Written by utils/vendor/vendor.mjs, do not edit.` : `Inlined into the ${recipe.package} fork.`,
    license: pkg.license,
    repository: pkg.repository,
    private: true,
    type: pkg.type,
    ...(entry ? { main: entry } : {}),
  }, null, 2) + '\n');
  return entry;
}

function packageEntry(sourceDir, pkg) {
  const conditions = pkg.exports?.['.'] ?? pkg.exports;
  const pick = value => {
    if (typeof value === 'string')
      return value;
    if (value && typeof value === 'object')
      return pick(value.node ?? value.import ?? value.require ?? value.default);
  };
  const entry = (typeof conditions === 'string' ? conditions : pick(conditions)) ?? pkg.main ?? 'index.js';
  return path.normalize(fs.existsSync(path.join(sourceDir, entry)) ? entry : entry + '.js');
}

function resolveRelative(sourceDir, from, specifier, isTypes) {
  const base = path.normalize(path.join(path.dirname(from), specifier));
  const candidates = isTypes
    ? [base.replace(/\.(c|m)?js$/, '.d.$1ts'), base + '.d.ts', path.join(base, 'index.d.ts'), base]
    : [base, base + '.js', base + '.cjs', path.join(base, 'index.js')];
  for (const candidate of candidates) {
    const full = path.join(sourceDir, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile())
      return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

// Imports in comments (usage examples) are not followed. Line comments are recognized only where
// `//` does not follow a colon or a quote, so that URLs in strings are not taken for comments.
function commentRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|(?<![:'"\\])\/\/[^\n]*/g))
    ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function bareName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function listFiles(dir, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory())
      result.push(...listFiles(dir, rel));
    else
      result.push(rel);
  }
  return result;
}
