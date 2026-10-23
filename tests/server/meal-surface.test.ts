import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionUrl, modelProvider } from '../../server/config';
import { generateMealUI } from '../../server/meal-surface';
import {
  a2uiComponentSchema,
  mealUIResponseSchema,
  modelGeneratedMealUIResponseFormat,
  openRouterMealUIResponseFormat,
  type MealUIResponse,
} from '../../server/schemas';

function mealResponse(): MealUIResponse {
  return {
    mealDraft: {
      title: 'Chicken',
      source: 'Model estimate',
      notes: 'Estimated portion',
      items: [
        {
          name: 'Chicken',
          servingLabel: '1 breast',
          servings: 1,
          calories: 280,
          protein: 52,
          carbs: 0,
          fat: 6,
          confidence: 0.8,
        },
      ],
    },
    a2ui: {
      surfaceId: 'macroquest-meal-chicken',
      components: [
        { id: 'root', component: 'Card', child: 'layout' },
        { id: 'layout', component: 'Column', children: ['totals', 'apply'] },
        { id: 'totals', component: 'Text', text: 'Calories: 280 Protein: 52 Carbs: 0 Fat: 6' },
        {
          id: 'apply',
          component: 'Button',
          child: 'apply-label',
          action: { event: { name: 'applyMealDraft' } },
        },
        { id: 'apply-label', component: 'Text', text: 'Apply found macros' },
      ],
      data: {},
    },
  };
}

test('OpenRouter drops bounded array constraints but preserves component shapes', () => {
  const local = modelGeneratedMealUIResponseFormat.json_schema.schema.properties;
  const remote = openRouterMealUIResponseFormat.json_schema.schema.properties;

  assert.equal(local.mealDraft.properties.items.minItems, 1);
  assert.equal(local.mealDraft.properties.items.maxItems, 6);
  assert.equal(local.a2ui.properties.components.minItems, 4);
  assert.equal(local.a2ui.properties.components.maxItems, 40);
  assert.equal('minItems' in remote.mealDraft.properties.items, false);
  assert.equal('maxItems' in remote.mealDraft.properties.items, false);
  assert.equal('minItems' in remote.a2ui.properties.components, false);
  assert.equal('maxItems' in remote.a2ui.properties.components, false);
  assert.deepEqual(remote.mealDraft.properties.items.items, local.mealDraft.properties.items.items);

  const localVariants = local.a2ui.properties.components.items.anyOf;
  const remoteVariants = remote.a2ui.properties.components.items.anyOf;
  assert.equal(remoteVariants.length, localVariants.length);
  localVariants.forEach((variant, index) => {
    if ('children' in variant.properties && 'maxItems' in variant.properties.children) {
      assert.equal(variant.properties.component.const, 'Row');
      const { minItems, maxItems, ...children } = variant.properties.children;
      assert.equal(minItems, 1);
      assert.equal(maxItems, 4);
      assert.deepEqual(remoteVariants[index], {
        ...variant,
        properties: { ...variant.properties, children },
      });
    } else {
      assert.deepEqual(remoteVariants[index], variant);
    }
  });
});

test('server validation enforces meal item and component count boundaries', () => {
  for (const count of [0, 1, 6, 7]) {
    const response = mealResponse();
    response.mealDraft.items = Array.from({ length: count }, () => response.mealDraft.items[0]);
    assert.equal(mealUIResponseSchema.safeParse(response).success, count >= 1 && count <= 6);
  }
  for (const count of [3, 4, 40, 41]) {
    const response = mealResponse();
    response.a2ui.components = Array.from({ length: count }, () => response.a2ui.components[0]);
    assert.equal(mealUIResponseSchema.safeParse(response).success, count >= 4 && count <= 40);
  }
});

test('server validation enforces Row limits without limiting Column children', () => {
  for (const count of [0, 1, 4, 5]) {
    const children = Array.from({ length: count }, (_, index) => `child-${index}`);
    assert.equal(
      a2uiComponentSchema.safeParse({ id: 'row', component: 'Row', children }).success,
      count >= 1 && count <= 4,
    );
    assert.equal(
      a2uiComponentSchema.safeParse({ id: 'column', component: 'Column', children }).success,
      true,
    );
  }
  assert.equal(a2uiComponentSchema.safeParse({ id: 'row', component: 'Row' }).success, false);
});

for (const image of [false, true]) {
  test(`meal ${image ? 'photo' : 'text'} request uses the active provider's schema`, async (t) => {
    const generated = mealResponse();
    const imageUrl = 'data:image/png;base64,dGVzdA==';
    const fetchMock = t.mock.method(
      globalThis,
      'fetch',
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(url, completionUrl);
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          body.response_format,
          modelProvider === 'openrouter'
            ? openRouterMealUIResponseFormat
            : modelGeneratedMealUIResponseFormat,
        );
        assert.match(body.messages[0].content[0].text, /1 to 6 items/);
        assert.match(body.messages[0].content[0].text, /4 to 40 components/);
        if (image) {
          assert.deepEqual(body.messages[0].content[1], {
            type: 'image_url',
            image_url: { url: imageUrl },
          });
        }
        return Response.json({
          choices: [{ message: { content: JSON.stringify(generated) } }],
        });
      },
    );

    const result = await generateMealUI(
      [
        {
          id: 'meal-request',
          role: 'user',
          content: image
            ? [
                { type: 'text', text: 'Analyze this meal' },
                {
                  type: 'image',
                  source: { type: 'data', mimeType: 'image/png', value: 'dGVzdA==' },
                },
              ]
            : 'Analyze a chicken breast',
        },
      ],
      [],
      new AbortController().signal,
    );

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.deepEqual(result.a2ui, generated.a2ui);
    assert.equal(result.draft.items[0].calories, 280);
  });
}

test('invalid model output is rejected before reaching the UI', async (t) => {
  const generated = mealResponse();
  generated.mealDraft.items = Array.from({ length: 7 }, () => generated.mealDraft.items[0]);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] }),
  );

  await assert.rejects(
    generateMealUI(
      [{ id: 'invalid-meal', role: 'user', content: 'Analyze my meal' }],
      [],
      new AbortController().signal,
    ),
    /Array must contain at most 6 element/,
  );
});
