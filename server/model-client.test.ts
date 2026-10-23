import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { modelProvider } from './config';
import { completeJson, streamJson } from './model-client';
import {
  mealUIResponseSchema,
  modelGeneratedMealUIResponseFormat,
  sandboxWidgetResponseFormat,
} from './schemas';

test('JSON completions preserve schema structure and relax only remote array caps', async (context) => {
  const original = JSON.stringify(modelGeneratedMealUIResponseFormat);
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const schema = body.response_format.json_schema.schema;
    assert.equal(schema.properties.mealDraft.properties.items.maxItems,
      modelProvider === 'openrouter' ? undefined : 6);
    const components = schema.properties.a2ui.properties.components;
    assert.equal(components.maxItems, modelProvider === 'openrouter' ? undefined : 40);
    assert.equal(components.items.anyOf.length, 6);
    assert.equal(components.items.anyOf[0].properties.component.const, 'Text');
    assert.equal(components.items.anyOf[1].properties.children.maxItems,
      modelProvider === 'openrouter' ? undefined : 4);
    assert.equal(schema.additionalProperties, false);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  });
  const result = await completeJson({
    prompt: 'Analyze a meal.',
    responseFormat: modelGeneratedMealUIResponseFormat,
    parser: z.object({ ok: z.boolean() }),
    maxTokens: 100,
    temperature: 0.15,
    abortSignal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.stringify(modelGeneratedMealUIResponseFormat), original);
});

test('streamed sandbox JSON retains its single-expression constraint', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.stream, true);
    const expressions = body.response_format.json_schema.schema.properties.jsExpressions;
    assert.equal(expressions.maxItems, 1);
    assert.equal(expressions.minItems, 1);
    return new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n');
  });
  const chunks: string[] = [];
  for await (const chunk of streamJson({
    prompt: 'Generate a widget.',
    responseFormat: sandboxWidgetResponseFormat,
    maxTokens: 100,
    temperature: 0.15,
    abortSignal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, ['{}']);
});

test('runtime meal validation enforces array caps without provider constraints', () => {
  const item = {
    name: 'Rice', servingLabel: 'cup', servings: 1, calories: 200,
    protein: 4, carbs: 44, fat: 0, confidence: 0.8,
  };
  const meal = {
    mealDraft: { title: 'Rice bowl', source: 'test', notes: '', items: [item] },
    a2ui: { surfaceId: 'meal', components: [{ id: 'root', component: 'Column' }], data: {} },
  };
  assert.equal(mealUIResponseSchema.safeParse(meal).success, true);
  assert.equal(mealUIResponseSchema.safeParse({
    ...meal, mealDraft: { ...meal.mealDraft, items: Array(7).fill(item) },
  }).success, false);
  assert.equal(mealUIResponseSchema.safeParse({
    ...meal, a2ui: { ...meal.a2ui, components: Array(41).fill(meal.a2ui.components[0]) },
  }).success, false);
  assert.equal(mealUIResponseSchema.safeParse({
    ...meal, a2ui: { ...meal.a2ui, components: [
      { id: 'root', component: 'Row', children: ['a', 'b', 'c', 'd', 'e'] },
    ] },
  }).success, false);
});