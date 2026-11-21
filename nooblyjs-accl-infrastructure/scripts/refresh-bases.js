#!/usr/bin/env node
// Refreshes agent/runtimes/bases.json (spec 8.3.1): asks Docker Hub for the current digest of each base image's tag
// (the multi-platform index) and pins it. Run it, read the diff, run the tests, commit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'runtimes', 'bases.json');
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'];

async function digestOf(image) {
  const [name, tag] = image.split('@')[0].split(':');
  const repo = name.includes('/') ? name : `library/${name}`;
  const auth = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`);
  if (!auth.ok) throw new Error(`Docker Hub refused a token for ${repo}: ${auth.status}`);
  const { token } = await auth.json();
  const res = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT.join(', ') } });
  const digest = res.headers.get('docker-content-digest');
  if (!res.ok || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`No digest for ${name}:${tag}: ${res.status}`);
  return `${name}:${tag}@${digest}`;
}

const file = JSON.parse(await fs.readFile(FILE, 'utf8'));
for (const [key, image] of Object.entries(file.bases)) {
  const next = await digestOf(image);
  console.log(next === image ? `${key}: unchanged` : `${key}: ${image} → ${next}`);
  file.bases[key] = next;
}
file.refreshedAt = new Date().toISOString().slice(0, 10);
await fs.writeFile(FILE, `${JSON.stringify(file, null, 2)}\n`);
