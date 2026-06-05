import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from './llmClient.js';
import { OpenAIChatClient, OPENAI_CHAT_COMPLETIONS_URL } from './openaiChatClient.js';
import { VisionClient } from './visionClient.js';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json'
  }
});

test('direct OpenAI chat client posts JSON chat completion requests', async () => {
  let request = null;
  const client = new OpenAIChatClient({
    apiKey: 'sk-test',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ choices: [] });
    }
  });

  const result = await client.create({ model: 'gpt-test', messages: [] });

  assert.deepEqual(result, { choices: [] });
  assert.equal(request.url, OPENAI_CHAT_COMPLETIONS_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-test');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'gpt-test', messages: [] });
});

test('direct OpenAI chat client surfaces API error messages', async () => {
  const client = new OpenAIChatClient({
    apiKey: 'sk-test',
    fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, 401)
  });

  await assert.rejects(() => client.create({ model: 'gpt-test', messages: [] }), /invalid api key/);
});

test('direct OpenAI chat client binds browser fetch to the global object', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async function(url, options) {
    called = true;
    if (this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    assert.equal(url, OPENAI_CHAT_COMPLETIONS_URL);
    assert.equal(options.method, 'POST');
    return jsonResponse({ choices: [] });
  };

  try {
    const client = new OpenAIChatClient({ apiKey: 'sk-test' });
    const result = await client.create({ model: 'gpt-test', messages: [] });

    assert.equal(called, true);
    assert.deepEqual(result, { choices: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vision client sends image analysis through strict chat completion schema', async () => {
  let payload = null;
  const client = new VisionClient({
    apiKey: 'sk-test',
    model: 'vision-test',
    maxTokens: 123,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                category: 'soda_can',
                brandOrTitle: 'Cola',
                description: 'red can',
                textSnippets: ['cola'],
                colors: ['red'],
                materials: ['aluminum'],
                confidence: 0.91
              })
            }
          }
        ]
      });
    }
  });

  const result = await client.identifyObject(new Blob(['can'], { type: 'image/jpeg' }), {
    class: 'bottle',
    confidence: 0.84
  });

  assert.equal(payload.model, 'vision-test');
  assert.equal(payload.max_tokens, 123);
  assert.equal(payload.response_format.json_schema.name, 'object_vision_result');
  assert.equal(payload.messages[0].content[0].type, 'text');
  assert.match(payload.messages[0].content[0].text, /Detected object class: bottle/);
  assert.equal(payload.messages[0].content[1].type, 'image_url');
  assert.match(payload.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(result, {
    category: 'soda_can',
    brandOrTitle: 'Cola',
    textSnippets: ['cola'],
    confidence: 0.91,
    description: 'red can',
    colors: ['red'],
    materials: ['aluminum']
  });
});

test('persona client sends emotional performance request through strict chat completion schema', async () => {
  let payload = null;
  const client = new LLMClient({
    apiKey: 'sk-test',
    model: 'persona-test',
    maxTokens: 256,
    temperature: 0.35,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                voiceStyle: 'dramatic',
                facialExpression: 'dramatic',
                emotionalDelivery: 'big theatrical delivery',
                animationIntensity: 0.9,
                tone: 'over the top',
                quirks: ['booms', 'poses', 'pauses'],
                oneLiners: ['I have arrived!', 'Still dramatic.', 'Farewell!']
              })
            }
          }
        ]
      });
    }
  });

  const result = await client.generatePersona({
    category: 'soda_can',
    description: 'red can',
    brandOrTitle: 'Cola',
    textSnippets: ['cola'],
    colors: ['red'],
    materials: ['aluminum']
  });

  assert.equal(payload.model, 'persona-test');
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.temperature, 0.35);
  assert.equal(payload.response_format.json_schema.name, 'object_persona');
  assert.match(payload.messages[1].content, /animation intensity/);
  assert.deepEqual(result, {
    voiceStyle: 'dramatic',
    facialExpression: 'dramatic',
    emotionalDelivery: 'big theatrical delivery',
    animationIntensity: 0.9,
    tone: 'over the top',
    quirks: ['booms', 'poses', 'pauses'],
    oneLiners: ['I have arrived!', 'Still dramatic.', 'Farewell!']
  });
});
