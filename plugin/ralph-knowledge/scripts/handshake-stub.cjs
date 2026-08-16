#!/usr/bin/env node
/**
 * Zero-dependency MCP stub, served ONLY while the real server's tree is still
 * bootstrapping (GH-1850).
 *
 * The launcher installs 155MB before it can serve. That is ~4.5s on a normal
 * link and inside Claude Code's 30s MCP startup deadline, but a slow link can
 * exceed it, and then the server is marked failed for the whole session and
 * the bootstrap it was waiting on is killed too — so the NEXT session starts
 * cold as well. This process exists to break that loop: it answers the
 * handshake immediately so the connection is established, while the real
 * install continues in the background and the next session picks up a finished
 * tree.
 *
 * It reports ZERO tools rather than the real ones. A tool list is a promise the
 * caller may act on; advertising tools that cannot run trades a clear "not yet"
 * for a failed call in the middle of someone's work. The `instructions` field
 * of the initialize result carries the reason, which is the one channel the
 * model actually reads.
 *
 * Deliberately dependency-free and in CommonJS: it must run BEFORE node_modules
 * exists, from the same Node the launcher found. Nothing here may import from
 * the package it is standing in for.
 */

'use strict';

// Echoed back to the client when it names one. The spec's negotiation is
// "answer with a version you support"; a stub that supports no features
// supports every version equally, and hard-coding one here would make this file
// a thing to remember to bump. The fallback is only for a client that sends
// nothing.
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

const INSTRUCTIONS =
  'ralph-knowledge is still installing its runtime in the background and has no ' +
  'tools available in this session. Nothing is broken and no action is needed: ' +
  'the install continues after this message and a new session will have the ' +
  'full toolset. Do not report this as a failure; use other sources for now.';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  // A notification has no id and MUST NOT be answered — including an unknown
  // one, where a "method not found" error would be a protocol violation rather
  // than a courtesy.
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
  const { id, method } = msg;

  switch (method) {
    case 'initialize':
      if (!isRequest) return;
      reply(id, {
        protocolVersion:
          typeof msg.params?.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : FALLBACK_PROTOCOL_VERSION,
        // Tools ARE declared as a capability while the list is empty: the
        // capability says this server deals in tools, the list says which are
        // available right now. A client that sees no tools capability may never
        // ask again.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ralph-knowledge (bootstrapping)', version: '0.0.0-bootstrap' },
        instructions: INSTRUCTIONS,
      });
      return;

    case 'tools/list':
      if (isRequest) reply(id, { tools: [] });
      return;

    case 'resources/list':
      if (isRequest) reply(id, { resources: [] });
      return;

    case 'resources/templates/list':
      if (isRequest) reply(id, { resourceTemplates: [] });
      return;

    case 'prompts/list':
      if (isRequest) reply(id, { prompts: [] });
      return;

    case 'ping':
      if (isRequest) reply(id, {});
      return;

    case 'tools/call':
      // Unreachable through a client that read tools/list, but a client may
      // hold a name from an earlier session. Answer with the reason rather than
      // "method not found", which would read as a broken server.
      if (isRequest) replyError(id, -32601, INSTRUCTIONS);
      return;

    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // No id can be recovered from unparseable bytes, so there is nobody to
      // answer. Staying alive beats exiting: dropping the connection here would
      // be reported as a crashed server.
      continue;
    }
    // A batch is a JSON array. Rare, but answering only the object form would
    // leave every request in it hanging until the client's own timeout.
    if (Array.isArray(msg)) msg.forEach((m) => m && typeof m === 'object' && handle(m));
    else if (msg && typeof msg === 'object') handle(msg);
  }
});

// The client closing stdin is the ordinary shutdown path.
process.stdin.on('end', () => process.exit(0));
