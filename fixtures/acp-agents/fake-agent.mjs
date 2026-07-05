/**
 * Deterministic fake ACP agent — test fixture for the AcpHarness (ADR-G).
 *
 * Speaks minimal ACP (JSON-RPC 2.0, newline-delimited, over stdio) with
 * scripted behaviour selected by FAKE_ACP_MODE:
 *
 *   happy         tool_call + tool_call_update with rawInput/rawOutput, end_turn
 *   no-raw        same flow but WITHOUT rawInput/rawOutput (degraded trace)
 *   no-contact    no tool calls at all — just a message chunk, end_turn
 *   unattributed  tool_call whose title matches no target tool
 *   permission    raises session/request_permission first; proceeds only on allow
 *   hang          answers initialize + session/new, never answers session/prompt
 *
 * FAKE_ACP_TITLE overrides the tool_call title (default 'weather_lookup').
 * The mcpServers[0].name received at session/new is echoed back inside
 * rawInput.receivedServer so tests can assert the target server was passed.
 *
 * Plain node, zero dependencies — do not import the ACP SDK here; the point
 * is to exercise the harness against an independent wire implementation.
 */

import { createInterface } from 'node:readline';

const MODE = process.env.FAKE_ACP_MODE ?? 'happy';
const TITLE = process.env.FAKE_ACP_TITLE ?? 'weather_lookup';

let receivedServer = null;
let initialized = false;
let nextServerRequestId = 1;
const pendingServerRequests = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function requestClient(method, params) {
  const id = `srv-${nextServerRequestId++}`;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function sessionUpdate(sessionId, update) {
  notify('session/update', { sessionId, update });
}

function toolCallFlow(sessionId) {
  const withRaw = MODE !== 'no-raw';
  const title = MODE === 'unattributed' ? 'Doing something mysterious' : TITLE;

  sessionUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title,
    kind: 'fetch',
    status: 'pending',
    ...(withRaw ? { rawInput: { city: 'Calgary', receivedServer } } : {}),
  });
  sessionUpdate(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    ...(withRaw ? { rawOutput: { tempC: 22, source: 'fake' } } : {}),
  });
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;

  switch (MODE) {
    case 'hang':
      return; // never answer — the harness timeout owns this case

    case 'no-contact':
      sessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'No tools needed for this.' },
      });
      respond(id, { stopReason: 'end_turn' });
      return;

    case 'permission': {
      const response = await requestClient('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'tc-perm', title: TITLE },
        options: [
          { optionId: 'rej-1', name: 'Reject', kind: 'reject_once' },
          { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always-1', name: 'Always allow', kind: 'allow_always' },
        ],
      });
      const outcome = response?.outcome;
      if (outcome?.outcome === 'selected' && outcome.optionId === 'allow-1') {
        toolCallFlow(sessionId);
        respond(id, { stopReason: 'end_turn' });
      } else {
        respond(id, { stopReason: 'refusal' });
      }
      return;
    }

    default:
      // happy / no-raw / unattributed
      toolCallFlow(sessionId);
      respond(id, { stopReason: 'end_turn' });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore garbage — a real agent would error
  }

  // Response to one of OUR requests (permission flow)
  if (msg.method === undefined && pendingServerRequests.has(msg.id)) {
    pendingServerRequests.get(msg.id)(msg.result);
    pendingServerRequests.delete(msg.id);
    return;
  }

  switch (msg.method) {
    case 'initialize':
      initialized = true;
      respond(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        agentCapabilities: {},
        authMethods: [],
      });
      break;

    case 'session/new':
      if (!initialized) {
        respondError(msg.id, -32600, 'session/new before initialize');
        break;
      }
      receivedServer = msg.params?.mcpServers?.[0]?.name ?? null;
      respond(msg.id, { sessionId: 'fake-sess-1' });
      break;

    case 'session/prompt':
      void handlePrompt(msg.id, msg.params);
      break;

    default:
      if (msg.id !== undefined) {
        respondError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
  }
});
