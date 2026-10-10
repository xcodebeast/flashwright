import { createHash } from 'node:crypto';

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Bind claims to declaration meaning without invalidating them for shifted line numbers. */
export function declarationFingerprint(entry) {
  const fields = ['id', 'parentId', 'kind', 'source', 'signature', 'defaults', 'targets', 'event', 'optional', 'heritage'];
  return sha256(JSON.stringify(Object.fromEntries(fields.filter(field => field in entry).map(field => [field, entry[field]]))));
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected nonempty text`);
}

function requireFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  if (unknown.length) throw new Error(`${label}: unknown fields ${unknown.join(', ')}`);
}

function requireRelativePath(path) {
  if (typeof path !== 'string' || !/^[a-zA-Z0-9_@./-]+$/.test(path) || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..') || path.startsWith('.cache/')) {
    throw new Error(`Parity reference must be a public repository-relative path: ${path}`);
  }
}

/** Reviews are explicit and non-inheriting; source presence alone is never conformance. */
export async function applyParityReviews(inventory, reviews, readReference) {
  requireFields(reviews, ['schemaVersion', 'referenceVersion', 'groups'], 'Parity reviews');
  if (reviews.schemaVersion !== 1 || reviews.referenceVersion !== inventory.referenceVersion || !Array.isArray(reviews.groups)) {
    throw new Error('Parity review schema or pinned reference mismatch');
  }
  const entries = new Map(inventory.entries.map(entry => [entry.id, entry]));
  if (entries.size !== inventory.entries.length) throw new Error('Duplicate capability ID');
  for (const entry of entries.values()) {
    if (entry.parentId !== null && !entries.has(entry.parentId)) throw new Error(`Unknown parent: ${entry.id}`);
    const ancestors = new Set([entry.id]);
    let parent = entries.get(entry.parentId);
    while (parent) {
      if (ancestors.has(parent.id)) throw new Error(`Cyclic parent: ${entry.id}`);
      ancestors.add(parent.id);
      parent = entries.get(parent.parentId);
    }
  }
  const groupIds = new Set();
  const claims = new Map();
  const referenceHashes = new Map();
  for (const group of reviews.groups) {
    requireFields(group, ['id', 'title', 'scope', 'limitations', 'defaults', 'differences', 'status', 'assessment', 'implementation', 'evidence', 'entries'], 'Parity review');
    if (!/^[a-z][a-z0-9-]*$/.test(group.id) || groupIds.has(group.id)) throw new Error(`Invalid or duplicate review ID: ${group.id}`);
    groupIds.add(group.id);
    for (const field of ['title', 'scope', 'limitations', 'defaults']) requireText(group[field], `${group.id}.${field}`);
    if (!Array.isArray(group.differences) || group.differences.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`${group.id}: differences must be an array of nonempty descriptions`);
    }
    const allowedAssessments = {
      experimental: ['verified-subset'], unsupported: ['explicit-rejection', 'missing'], supported: ['verified'],
    };
    if (!allowedAssessments[group.status]?.includes(group.assessment)) throw new Error(`${group.id}: invalid status/assessment`);
    if (!Array.isArray(group.implementation) || !group.implementation.length || !Array.isArray(group.evidence) || !group.evidence.length) {
      throw new Error(`${group.id}: implementation and evidence references are required`);
    }
    for (const reference of [...group.implementation, ...group.evidence]) {
      requireFields(reference, ['path', 'sha256', 'kind'], `${group.id} reference`);
      requireRelativePath(reference.path);
      if (!/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error(`${group.id}: invalid reference hash`);
      if (!referenceHashes.has(reference.path)) referenceHashes.set(reference.path, sha256(await readReference(reference.path)));
      if (referenceHashes.get(reference.path) !== reference.sha256) throw new Error(`${group.id}: stale reference ${reference.path}`);
    }
    for (const evidence of group.evidence) {
      if (!['conformance', 'package', 'source-review'].includes(evidence.kind)) throw new Error(`${group.id}: invalid evidence kind`);
    }
    if (group.status === 'experimental' && !group.evidence.some(reference => reference.kind === 'conformance')) {
      throw new Error(`${group.id}: experimental behavior requires conformance evidence`);
    }
    if (group.status === 'supported' && !['conformance', 'package'].every(kind => group.evidence.some(reference => reference.kind === kind))) {
      throw new Error(`${group.id}: supported behavior requires conformance and package evidence`);
    }
    if (!Array.isArray(group.entries) || !group.entries.length) throw new Error(`${group.id}: exact entries are required`);
    for (const claim of group.entries) {
      requireFields(claim, ['id', 'declarationSha256'], `${group.id} claim`);
      const entry = entries.get(claim.id);
      if (!entry) throw new Error(`${group.id}: unknown entry ${claim.id}`);
      if (claims.has(claim.id)) throw new Error(`Duplicate claim: ${claim.id}`);
      if (declarationFingerprint(entry) !== claim.declarationSha256) throw new Error(`${group.id}: stale declaration ${claim.id}`);
      claims.set(claim.id, group);
    }
  }
  return {
    ...inventory,
    reviewSource: 'compatibility/parity-reviews.json',
    reviewedEntries: claims.size,
    entries: inventory.entries.map(entry => {
      const group = claims.get(entry.id);
      return {
        ...entry,
        status: group?.status ?? 'planned',
        implementation: group ? group.implementation.map(reference => reference.path) : null,
        evidence: group ? group.evidence.map(reference => reference.path) : [],
        assessment: group?.assessment ?? 'unverified',
        review: group?.id ?? null,
      };
    }),
  };
}

function escapeCell(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', ' ');
}

function repositoryLink(path, label = path) {
  return `[${escapeCell(label)}](../${path})`;
}

const tableSources = [
  ['browser', 'playwright-core/types/types.d.ts'],
  ['structs', 'playwright-core/types/structs.d.ts'],
  ['runner', 'playwright/types/test.d.ts'],
  ['reporter', 'playwright/types/testReporter.d.ts'],
  ['packages', null],
];

/** Keep the human summary and exhaustive rows derived from the same validated claims. */
export function renderParityTables(catalog, reviews) {
  const outputs = new Map();
  const knownSources = new Set(tableSources.map(([, source]) => source).filter(Boolean));
  if (catalog.entries.some(entry => entry.kind !== 'package-subpath' && !knownSources.has(entry.source))) throw new Error('An inventory source has no parity table');
  const counts = Object.fromEntries(['supported', 'experimental', 'unsupported', 'planned'].map(status => [status, catalog.entries.filter(entry => entry.status === status).length]));
  const summary = [
    '# Playwright and Flashwright compatibility', '',
    `Generated by \`bun run inventory\` from Playwright ${catalog.referenceVersion} declarations and reviewed claims. Edit ${repositoryLink(catalog.reviewSource)}, then regenerate.`, '',
    'Flashwright remains an experimental Chromium implementation. These tables describe recorded development evidence, not release acceptance or a performance claim. Historical checkpoints retain their own runtime, platform and source limits.', '',
    `The complete inventory contains ${catalog.entries.length} entries: ${counts.supported} supported, ${counts.experimental} experimental, ${counts.unsupported} unsupported and ${counts.planned} planned/unverified. These counts include types, overloads, options and parameters; they are not a percentage of working features.`, '',
    '| Status / assessment | Meaning |', '| --- | --- |',
    '| Supported / verified | Reviewed conformance and package evidence for the stated scope. |',
    '| Experimental / verified-subset | Development evidence exists for the stated subset; read its limits. |',
    '| Unsupported / explicit-rejection | The public path deliberately rejects this behavior. Evidence may be source review only. |',
    '| Unsupported / missing | Source review found no implementation at the stated public boundary. A typed rejection is not established. |',
    '| Planned / unverified | No exact-entry review yet. This does not establish absence or failure. |', '',
    'Claims do not propagate to child options, sibling overloads, enclosing types or inherited runner methods. Default excerpts in the JSON are reference documentation; each review separately states what is known about runtime defaults.', '',
    '## Reviewed feature groups', '', '| Feature | Status | Exact entries | Verified scope / difference |', '| --- | --- | ---: | --- |',
  ];
  for (const group of reviews.groups) {
    summary.push(`| [${escapeCell(group.title)}](#${group.id}) | ${group.status} / ${group.assessment} | ${group.entries.length} | ${escapeCell(group.scope)} |`);
  }
  summary.push('', '## Complete entry tables', '', 'Every pinned entry appears once below. Its exact declaration, reference defaults, nearest inventoried parent and evidence paths are also retained in the [machine-readable inventory](../compatibility/capabilities.json).', '');
  for (const [name, source] of tableSources) {
    const entries = catalog.entries.filter(entry => source ? entry.source === source : entry.kind === 'package-subpath');
    const destination = `docs/parity-${name}.md`;
    summary.push(`- [${name}](parity-${name}.md): ${entries.length} entries.`);
    const lines = [`# ${name} parity entries`, '', '[Status definitions and reviewed scopes](compatibility.md). Generated; do not edit.', '', '| Exact reference entry | Kind | Status / assessment | Review |', '| --- | --- | --- | --- |'];
    for (const entry of entries) {
      lines.push(`| ${escapeCell(entry.id)} | ${entry.kind} | ${entry.status} / ${entry.assessment} | ${entry.review ? `[scope and evidence](compatibility.md#${entry.review})` : 'Unreviewed'} |`);
    }
    outputs.set(destination, lines.join('\n') + '\n');
  }
  for (const group of reviews.groups) {
    summary.push('', `<a id="${group.id}"></a>`, '', `## ${group.title}`, '', group.scope, '', `Limits: ${group.limitations}`, '', `Runtime defaults: ${group.defaults}`, '', `Assessment: ${group.status} / ${group.assessment}.`, '', `Implementation: ${group.implementation.map(reference => repositoryLink(reference.path)).join(', ')}.`, '', `Evidence: ${group.evidence.map(reference => `${repositoryLink(reference.path)} (${reference.kind})`).join(', ')}.`);
    if (group.differences.length) summary.push('', 'Intentional differences:', '', ...group.differences.map(difference => `- ${difference}`));
  }
  outputs.set('docs/compatibility.md', summary.join('\n') + '\n');
  return outputs;
}
