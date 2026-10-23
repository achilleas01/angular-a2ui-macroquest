import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@ag-ui/core';
import { contextBlock } from './agui';
import { buildMealUIPrompt } from './prompts';

test('model context excludes SDK catalog/schema protocol but preserves state and sandbox context', () => {
  const retained: Context[] = [
    { description: 'MacroQuest trusted Angular state', value: '{"goals":{"calories":2100}}' },
    { description: 'A2UI catalog capabilities: available catalog IDs', value: 'basic_catalog.json' },
    { description: 'A2UI design guidelines — visual design rules', value: 'Use clear hierarchy.' },
    { description: 'Design guidelines for the generateSandboxedUi tool.', value: 'Use accessible controls.' },
    {
      description: 'Sandbox functions available in generated sandboxed UI code.',
      value: 'Call Websandbox.connection.remote.applyMacroSwap(args)',
    },
  ];
  const redundant: Context[] = [
    {
      description: 'A2UI Component Schema — available components for generating UI surfaces.',
      value: 'full-sdk-catalog'.repeat(4000),
    },
    {
      description: 'A2UI generation guidelines — protocol rules, tool arguments, path rules',
      value: 'Call the SDK render tool with operations.',
    },
  ];

  const block = contextBlock([...retained, ...redundant]);
  assert.equal(block, contextBlock(retained));
  for (const entry of retained) {
    assert.ok(block.includes(entry.value));
  }
  assert.ok(!block.includes('full-sdk-catalog'));
  assert.ok(!block.includes('Call the SDK render tool'));

  const prompt = buildMealUIPrompt('Analyze a chicken bowl.', '', block);
  assert.ok(prompt.includes('"mealDraft"'));
  assert.ok(prompt.includes('"applyMealDraft"'));
  assert.ok(prompt.includes('User request: Analyze a chicken bowl.'));
  assert.ok(prompt.includes('The current image is the source of truth'));
  assert.ok(prompt.includes('identify the foods visible in the current image from scratch'));
});

test('context keeps unknown entries and ignores blank values', () => {
  assert.equal(contextBlock([]), '');
  assert.equal(contextBlock([{ description: 'empty', value: ' \n ' }]), '');
  assert.equal(
    contextBlock([{ description: '', value: 'additional app context' }]),
    'Trusted app state:\n- context: additional app context',
  );
});
