/**
 * Plexus Relay — tests
 * Uses Node's built-in test runner (node --test) + http client.
 * No extra test deps needed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Override env for testing
process.env.PORT = '0'; // random port
process.env.ROSTER = 'Roger,Catalyst,Pontus,Aria';
process.env.MAX_MESSAGES = '50';

const app = require('./index.js');

let server;
let baseUrl;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {}
    };
    if (body) {
      const payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// We need to grab the actual listening port from the server
// The app module already called .listen() — grab the address
before(() => {
  return new Promise((resolve) => {
    // The server is already listening from index.js import
    // We need to find it. The app.listen returns the server, but module.exports = app.
    // Let's just create our own server from the app.
    // Actually index.js already started a server. Let's find the port.
    // We'll start a fresh one on a random port.
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

describe('GET /health', () => {
  it('returns ok and roster', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepStrictEqual(res.body.roster, ['Roger', 'Catalyst', 'Pontus', 'Aria']);
  });
});

describe('GET /relay', () => {
  it('returns empty messages at start', async () => {
    const res = await request('GET', '/relay?cursor=0');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
    assert.equal(typeof res.body.cursor, 'number');
  });
});

describe('POST /relay', () => {
  it('accepts a valid message', async () => {
    const res = await request('POST', '/relay', { name: 'Roger', text: 'Hello relay' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.cursor, 'number');
  });

  it('rejects name not in roster', async () => {
    const res = await request('POST', '/relay', { name: 'Hacker', text: 'hi' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('Name must be'));
  });

  it('rejects missing text', async () => {
    const res = await request('POST', '/relay', { name: 'Catalyst' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('Text is required'));
  });

  it('rejects text over 2000 chars', async () => {
    const longText = 'x'.repeat(2001);
    const res = await request('POST', '/relay', { name: 'Pontus', text: longText });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('2000'));
  });

  it('accepts text exactly 2000 chars', async () => {
    const text = 'a'.repeat(2000);
    const res = await request('POST', '/relay', { name: 'Aria', text });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

describe('Message stream', () => {
  it('retrieves posted messages with cursor', async () => {
    // Post a known message
    await request('POST', '/relay', { name: 'Catalyst', text: 'Test stream message' });

    // Fetch from start
    const res = await request('GET', '/relay?cursor=0');
    assert.equal(res.status, 200);
    const msgs = res.body.messages;
    assert.ok(msgs.length >= 1);
    const last = msgs[msgs.length - 1];
    assert.equal(last.name, 'Catalyst');
    assert.equal(last.text, 'Test stream message');
    assert.equal(typeof last.ts, 'number');
    assert.equal(typeof last.id, 'number');

    // Fetch with cursor at end returns empty
    const res2 = await request('GET', `/relay?cursor=${res.body.cursor}`);
    assert.equal(res2.body.messages.length, 0);
    assert.equal(res2.body.cursor, res.body.cursor);
  });
});

describe('Rotation', () => {
  it('rotates when exceeding MAX_MESSAGES', async () => {
    // MAX_MESSAGES is 50 for testing. Post enough to trigger rotation.
    // We already have a few messages, post ~50 more.
    const promises = [];
    for (let i = 0; i < 55; i++) {
      promises.push(request('POST', '/relay', { name: 'Roger', text: `Msg ${i}` }));
    }
    await Promise.all(promises);

    // Fetch all — should be under max
    const res = await request('GET', '/relay?cursor=0');
    assert.ok(res.body.messages.length <= 50, `Expected <=50, got ${res.body.messages.length}`);
    assert.ok(res.body.messages.length > 0);
  });
});
