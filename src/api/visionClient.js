import { VISION_RESPONSE_FORMAT, validateVisionResult } from './structuredOutputSchemas.js';
import { LocalAIClient, readChatCompletionContent } from './localAIClient.js';
import { readViteEnv } from './viteEnv.js';
import { VISION_CONTENT_LIMITS, readBoundedText } from '../contracts/objectContent.js';
import { assertVisionImageBlob } from '../contracts/visionImage.js';

export class VisionClient {
  constructor(config = {}) {
    const model =
      config.model ?? readViteEnv('VITE_LOCAL_AI_VISION_MODEL') ?? readViteEnv('VITE_LOCAL_AI_MODEL');
    this.config = {
      model,
      maxTokens: config.maxTokens ?? 300,
    };

    if (typeof this.config.model !== 'string' || this.config.model.trim().length === 0) {
      throw new Error('Set VITE_LOCAL_AI_MODEL or VITE_LOCAL_AI_VISION_MODEL for object vision.');
    }
    this.config.model = this.config.model.trim();
    if (!Number.isInteger(this.config.maxTokens) || this.config.maxTokens <= 0) {
      throw new RangeError('Vision maxTokens must be a positive integer.');
    }

    if (
      Object.hasOwn(config, 'chatClient') &&
      typeof config.chatClient?.createChatCompletion !== 'function'
    ) {
      throw new TypeError('Vision chatClient must implement createChatCompletion.');
    }
    this.chatClient = Object.hasOwn(config, 'chatClient')
      ? config.chatClient
      : new LocalAIClient({
          ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
          ...(Object.hasOwn(config, 'fetchImpl') ? { fetchImpl: config.fetchImpl } : {}),
          ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
          ...(Object.hasOwn(config, 'scheduleRequestTimeout')
            ? { scheduleRequestTimeout: config.scheduleRequestTimeout }
            : {}),
        });
  }

  async identifyObject(imageBlob, { objectInfo = {}, signal } = {}) {
    signal?.throwIfAborted();
    assertVisionImageBlob(imageBlob);
    const base64Image = await this.blobToBase64(imageBlob, { signal });
    signal?.throwIfAborted();

    const prompt = this.buildVisionPrompt(objectInfo);

    const response = await this.chatClient.createChatCompletion(
      {
        model: this.config.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
              {
                type: 'image_url',
                image_url: {
                  url: base64Image,
                  detail: 'low',
                },
              },
            ],
          },
        ],
        max_tokens: this.config.maxTokens,
        response_format: VISION_RESPONSE_FORMAT,
      },
      { signal },
    );
    signal?.throwIfAborted();

    const content = readChatCompletionContent(response);
    const result = JSON.parse(content);
    return validateVisionResult(result);
  }

  buildVisionPrompt(objectInfo = {}) {
    if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) {
      throw new TypeError('Vision objectInfo must be an object.');
    }
    const selectedClass =
      objectInfo.class === undefined
        ? null
        : readBoundedText(objectInfo.class, {
            label: 'Vision objectInfo.class',
            maxCharacters: VISION_CONTENT_LIMITS.maxCategoryCharacters,
          });
    if (
      objectInfo.confidence !== undefined &&
      (!Number.isFinite(objectInfo.confidence) || objectInfo.confidence < 0 || objectInfo.confidence > 1)
    ) {
      throw new RangeError('Vision objectInfo.confidence must be a finite number from 0 to 1.');
    }
    return `Analyze this object image and return a JSON object with the following fields:

{
  "category": "specific object type; at most ${VISION_CONTENT_LIMITS.maxCategoryCharacters} Unicode characters",
  "brandOrTitle": "visible brand or product title, or an empty string; at most ${VISION_CONTENT_LIMITS.maxBrandOrTitleCharacters} Unicode characters",
  "description": "brief appearance description; at most ${VISION_CONTENT_LIMITS.maxDescriptionCharacters} Unicode characters",
  "textSnippets": ["at most ${VISION_CONTENT_LIMITS.maxTextSnippets} entries; each at most ${VISION_CONTENT_LIMITS.maxTextSnippetCharacters} Unicode characters"],
  "colors": ["at most ${VISION_CONTENT_LIMITS.maxColors} entries; each at most ${VISION_CONTENT_LIMITS.maxColorCharacters} Unicode characters"],
  "materials": ["at most ${VISION_CONTENT_LIMITS.maxMaterials} entries; each at most ${VISION_CONTENT_LIMITS.maxMaterialCharacters} Unicode characters"],
  "confidence": 0.85
}

${selectedClass !== null ? `Selected object class: ${selectedClass}` : ''}
${objectInfo.confidence !== undefined ? `Selection confidence: ${objectInfo.confidence}` : ''}

Focus on details that would help create a unique personality for this object. Return ONLY the JSON object.`;
  }

  async blobToBase64(blob, { signal } = {}) {
    assertVisionImageBlob(blob);
    signal?.throwIfAborted();
    const buffer = await blob.arrayBuffer();
    signal?.throwIfAborted();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let index = 0; index < bytes.length; index += chunkSize) {
      signal?.throwIfAborted();
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    signal?.throwIfAborted();
    return `data:${blob.type};base64,${btoa(binary)}`;
  }
}
