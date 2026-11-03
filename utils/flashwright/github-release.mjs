#!/usr/bin/env node
// Creates the GitHub Release of a pushed version tag, with notes from the commits since the previous one.
// release.mjs runs it after pushing the tag; run it by hand to catch up on a tag without a release.
//
// Usage: node utils/flashwright/github-release.mjs <tag> [--dry-run]
// --dry-run prints the notes instead of creating the release.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const repo = 'xcodebeast/flashwright';
const tag = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!/^v\d+\.\d+\.\d+-flashwright\.\d+$/.test(tag ?? '')) {
  console.error('Usage: node utils/flashwright/github-release.mjs v<version> [--dry-run]');
  process.exit(1);
}

const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = tag.slice(1);

// The versions before this one, newest first; version sort keeps .10 after .9.
const tags = read('git', ['tag', '--list', 'v*-flashwright.*', '--sort=-v:refname']).split('\n');
const previous = tags[tags.indexOf(tag) + 1];

// What users of the packages notice: not the benchmark, the site or the release tooling.
const internalScopes = new Set(['bench', 'site', 'release', 'readme']);
const sections = [['feat', 'New'], ['perf', 'Faster'], ['fix', 'Fixed']];
const groups = new Map(sections.map(([label]) => [label, []]));
for (const subject of read('git', ['log', '--format=%s', previous ? `${previous}..${tag}` : tag]).split('\n')) {
  const match = /^(\w+)(?:\(([^)]*)\))?: (.+)$/.exec(subject);
  if (match && groups.has(match[1]) && !internalScopes.has(match[2])) {
    // Only plain words: getByLabel, accept-snapshots and --watch are names.
    const line = /^[a-z]+\s/.test(match[3]) ? match[3][0].toUpperCase() + match[3].slice(1) : match[3];
    groups.get(match[1]).push(line);
  }
}

const notes = [
  '```bash',
  `npm i -D @playwright/test@npm:flashwright-test@${version}`,
  '```',
  ...sections.filter(([label]) => groups.get(label).length).flatMap(([label, title]) => ['', `### ${title}`, ...groups.get(label).map(line => `- ${line}`)]),
  ...(previous ? ['', `Full list: https://github.com/${repo}/compare/${previous}...${tag}`] : []),
].join('\n');

if (dryRun) {
  console.log(notes);
  process.exit(0);
}

let exists = true;
try {
  read('gh', ['release', 'view', tag, '-R', repo]);
} catch {
  exists = false;
}
if (exists) {
  console.log(`The GitHub Release of ${tag} already exists.`);
  process.exit(0);
}
execFileSync('gh', ['release', 'create', tag, '-R', repo, '--verify-tag', '--latest', '--title', version, '--notes', notes], { cwd: root, stdio: 'inherit' });
