/**
 * github-store.js — durable message store for the Plexus Relay.
 * Mirrors messages to a JSON file in GitHub so they survive Render restarts.
 *
 * Env:
 *   GITHUB_TOKEN       required — PAT with Contents: read+write on this repo
 *   GITHUB_STORE_REPO  default "Keywebco/plexus-relay"
 *   GITHUB_STORE_PATH  default "store/messages.json"
 *   GITHUB_BRANCH      default "main"
 */

const REPO = process.env.GITHUB_STORE_REPO || 'Keywebco/plexus-relay';
const STORE_PATH = process.env.GITHUB_STORE_PATH || 'store/messages.json';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const API = `https://api.github.com/repos/${REPO}/contents/${STORE_PATH}`;

function configured() {
  return !!process.env.GITHUB_TOKEN;
}

function headers() {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'plexus-relay'
  };
}

let storeSha = null;
let saveChain = Promise.resolve();

async function ghLoad() {
  if (!configured()) return null;
  const res = await fetch(`${API}?ref=${BRANCH}`, { headers: headers() });
  if (res.status === 404) return { messages: [], sha: null };
  if (!res.ok) throw new Error(`GitHub load failed: ${res.status}`);
  const data = await res.json();
  storeSha = data.sha || null;
  const text = Buffer.from(data.content || '', 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  return { messages: Array.isArray(parsed) ? parsed : [], sha: storeSha };
}

function mergeRemote(getMessages, remote) {
  const local = getMessages();
  const seen = new Set(remote.map(m => `${m.ts}|${m.name}|${m.text}`));
  const merged = remote.slice();
  for (const m of local) {
    const k = `${m.ts}|${m.name}|${m.text}`;
    if (!seen.has(k)) { seen.add(k); merged.push(m); }
  }
  merged.forEach((m, i) => { m.id = i; });
  return merged;
}

async function ghPut(messages, sha) {
  const body = {
    message: `relay: persist ${messages.length} messages`,
    content: Buffer.from(JSON.stringify(messages), 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  const res = await fetch(API, {
    method: 'PUT', headers: headers(), body: JSON.stringify(body)
  });
  return res;
}

async function ghSaveOnce(getMessages) {
  let res = await ghPut(getMessages(), storeSha);
  if (res.status === 409 || res.status === 422) {
    const latest = await ghLoad();
    const merged = mergeRemote(getMessages, latest ? latest.messages : []);
    res = await ghPut(merged, latest ? latest.sha : null);
    if (!res.ok) throw new Error(`GitHub save retry failed: ${res.status}`);
    const data = await res.json();
    storeSha = (data.content && data.content.sha) || storeSha;
    return;
  }
  if (!res.ok) throw new Error(`GitHub save failed: ${res.status}`);
  const data = await res.json();
  storeSha = (data.content && data.content.sha) || storeSha;
}

function ghSave(getMessages) {
  if (!configured()) return;
  saveChain = saveChain
    .then(() => ghSaveOnce(getMessages))
    .catch(err => console.warn(
      '[plexus] GitHub save failed (will retry on next flush):', err.message));
}

function ghFlushSync() {
  return saveChain;
}

module.exports = { ghLoad, ghSave, ghFlushSync, configured };
