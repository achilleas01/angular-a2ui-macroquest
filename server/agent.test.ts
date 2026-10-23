import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { BaseEvent, Message } from '@ag-ui/core';
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from '@copilotkit/runtime/v2';
import { agent } from './agent';
import { assistantCopy } from './prompts';

type TextEvent = BaseEvent & { messageId?: string; delta?: string };

for (const scenario of [
  { intent: 'macro_swap_lab', interrupted: false, reply: assistantCopy.swapLabReady },
  { intent: 'macro_swap_lab', interrupted: true, reply: assistantCopy.swapLabFailed },
  { intent: 'macro_chart', interrupted: true, reply: assistantCopy.chartFailed },
]) {
  test(`${scenario.intent} ${scenario.interrupted ? 'failure' : 'success'} opens fresh post-tool text`, async (context) => {
    let requests = 0;
    context.mock.method(console, 'warn', () => {});
    context.mock.method(globalThis, 'fetch', async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({ choices: [{ message: {
          content: JSON.stringify({ intent: scenario.intent }),
        } }] });
      }
      assert.equal(requests, 2);
      const chunk = 'data: {"choices":[{"delta":{"content":"{}"}}]}\n\n';
      if (!scenario.interrupted) {
        return new Response(`${chunk}data: [DONE]\n\n`);
      }
      let emitted = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode(chunk));
          } else {
            controller.error(new Error('Model stream interrupted.'));
          }
        },
      }));
    });

    const events = await new Promise<TextEvent[]>((resolve, reject) => {
      const collected: TextEvent[] = [];
      agent.clone().run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', content: 'Update my meal.' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      }).subscribe({
        next: (event) => collected.push(event),
        error: reject,
        complete: () => resolve(collected),
      });
    });

    const closedTextIds = new Set<string>();
    let activeTextId: string | undefined;
    for (const event of events) {
      if (event.type === 'TOOL_CALL_START' && activeTextId) {
        closedTextIds.add(activeTextId);
        activeTextId = undefined;
      }
      if (event.type === 'TEXT_MESSAGE_CHUNK') {
        assert.ok(event.messageId);
        assert.equal(closedTextIds.has(event.messageId), false,
          'Text after a tool call must not reuse a closed message ID.');
        activeTextId = event.messageId;
      }
    }
    assert.equal(closedTextIds.size, 1);
    assert.equal(events.filter((event) => event.delta === scenario.reply).length, 1);
    assert.equal(requests, 2);
  });
}

for (const ending of ['assistant', 'activity', 'tool'] as const) {
  test(`sandbox continuation ending in ${ending} does not regenerate UI`, async (context) => {
    let requests = 0;
    context.mock.method(globalThis, 'fetch', async () => {
      requests += 1;
      throw new Error('A continuation must not call the model.');
    });
    const messages: Message[] = [
      { id: 'user-swap', role: 'user', content: 'Suggest a lighter version of my current meal.' },
      { id: 'sandbox-call', role: 'assistant', toolCalls: [{
        id: 'sandbox-tool', type: 'function',
        function: { name: 'generateSandboxedUi', arguments: '{}' },
      }] },
      { id: 'sandbox-result', role: 'tool', toolCallId: 'sandbox-tool', content: '{}' },
    ];
    if (ending === 'assistant') {
      messages.push({ id: 'swap-ready', role: 'assistant', content: assistantCopy.swapLabReady });
    } else if (ending === 'activity') {
      messages.push({
        id: 'sandbox-activity', role: 'activity', activityType: 'open-generative-ui', content: {},
      } as unknown as Message);
    }
    const events = await new Promise<TextEvent[]>((resolve, reject) => {
      const collected: TextEvent[] = [];
      agent.clone().run({
        threadId: randomUUID(), runId: randomUUID(), messages,
        state: {}, tools: [], context: [], forwardedProps: {},
      }).subscribe({
        next: (event) => collected.push(event),
        error: reject,
        complete: () => resolve(collected),
      });
    });
    assert.equal(requests, 0);
    assert.deepEqual(events.map((event) => event.type), ['RUN_STARTED', 'RUN_FINISHED']);
  });
}

test('chart runtime emits one ordered run lifecycle through sandbox middleware', async (context) => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    if (requests === 1) {
      return Response.json({ choices: [{ message: { content: '{"intent":"macro_chart"}' } }] });
    }
    assert.equal(requests, 2);
    const widget = {
      initialHeight: 600, placeholderMessages: ['Drawing chart'],
      css: 'body { margin: 0; }', html: '<section>Macro chart</section>',
      jsFunctions: 'globalThis.ready = true;', jsExpressions: ['globalThis.ready'],
    };
    const argumentsJson = JSON.stringify(widget);
    const chunks = argumentsJson.match(/.{1,17}/g) ?? [];
    return new Response(chunks.map((content) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    ).join('') + 'data: [DONE]\n\n');
  });
  const runtime = new CopilotRuntime({
    agents: { default: agent.clone() }, runner: new InMemoryAgentRunner(), openGenerativeUI: true,
    a2ui: {
      injectA2UITool: 'macroquest_render_a2ui', a2uiToolNames: ['macroquest_render_a2ui'],
      defaultCatalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
    },
  });
  const handler = createCopilotRuntimeHandler({ runtime, basePath: '/api/copilotkit' });
  const runId = randomUUID();
  const threadId = randomUUID();
  const response = await handler(new Request('http://localhost/api/copilotkit/agent/default/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId, runId,
      messages: [{ id: randomUUID(), role: 'user', content: 'Show me a chart of my macros versus my goals.' }],
      state: {}, tools: [], context: [], forwardedProps: {},
    }),
  }));
  let body = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body!) {
    body += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  body += decoder.decode();
  assert.equal(response.status, 200, body);
  const events = body.split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)));
  assert.equal(events.filter((event) => event.type === 'RUN_STARTED').length, 1);
  assert.equal(events.filter((event) => event.type === 'RUN_FINISHED').length, 1);
  assert.equal(events[0].type, 'RUN_STARTED');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
  assert.equal(events.at(-1).runId, runId);
  assert.equal(events.some((event) => event.type === 'ACTIVITY_SNAPSHOT'), true);
  const continuationRunId = randomUUID();
  const continuation = await handler(new Request('http://localhost/api/copilotkit/agent/default/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId, runId: continuationRunId,
      messages: [{ id: randomUUID(), role: 'tool', toolCallId: 'chart-tool', content: '{}' }],
      state: {}, tools: [], context: [], forwardedProps: {},
    }),
  }));
  let continuationBody = '';
  for await (const chunk of continuation.body!) {
    continuationBody += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  continuationBody += decoder.decode();
  assert.equal(continuation.status, 200, continuationBody);
  const continuationEvents = continuationBody.split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(continuationEvents.map((event) => event.type), ['RUN_STARTED', 'RUN_FINISHED']);
  assert.equal(continuationEvents[0].runId, continuationRunId);
  assert.equal(continuationEvents[1].runId, continuationRunId);
  assert.equal(requests, 2);
});