const { OpenAI } = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');

require('dotenv').config();

const SYSTEM_PROMPT = `You are a skilled narrative storyteller. Your job is to take factual Wikipedia content and transform it into a compelling, readable narrative.

Guidelines:
- Write in a vivid, engaging tone suitable for a curious general reader.
- Preserve all key facts and important context; do not invent events or quotes.
- Use a clear narrative arc: set the scene, introduce the subject, develop the important events or ideas, and conclude with why it matters.
- Keep paragraphs reasonably short and the pacing lively.
- Avoid sounding like an encyclopedia entry.
- Output only the narrative story; do not include markdown headings unless they help the flow.
`;

const STYLE_GUIDES = {
  standard: '',
  bedtime:
    'Narration style: a gentle, warm bedtime story. Soothing voice, soft pacing, cozy imagery. Wind down toward a calm, comforting ending — nothing jarring.',
  kids: 'Narration style: for kids around 8-12. Simple, lively language — explain any big words in passing. Lead with wonder and excitement; short punchy paragraphs.',
  dramatic:
    'Narration style: cinematic and dramatic. Heighten tension and stakes, vivid scene-setting, a strong arc that builds to a climax. Bold, propulsive energy.',
};

const STYLE_IDS = Object.keys(STYLE_GUIDES);

function buildMessages(page, style) {
  const guide = STYLE_GUIDES[style] || '';
  const system = guide ? `${SYSTEM_PROMPT}\n${guide}` : SYSTEM_PROMPT;
  const userContent = `Turn the following Wikipedia article into an interesting narrative.\n\nTitle: ${page.title}\nDescription: ${page.description}\nSummary: ${page.summary}\n\nFull text:\n${page.extract}\n`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

function isOpenRouter(baseURL) {
  return baseURL && baseURL.includes('openrouter.ai');
}

function getOpenAIClient() {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const config = {
    apiKey: process.env.LLM_API_KEY || 'ollama',
  };
  if (process.env.LLM_BASE_URL) {
    config.baseURL = process.env.LLM_BASE_URL;
  } else if (provider === 'ollama') {
    config.baseURL = 'http://localhost:11434/v1';
  }

  // OpenRouter prefers these headers for its rankings and telemetry.
  if (isOpenRouter(config.baseURL)) {
    config.defaultHeaders = {
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost',
      'X-Title': process.env.OPENROUTER_TITLE || 'FunStory',
    };
  }

  return new OpenAI(config);
}

// LLM_MODEL may be a comma-separated list; extra entries act as OpenRouter fallbacks (max 3)
function getModels() {
  return (process.env.LLM_MODEL || 'gpt-4o-mini')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function* generateNarrative(page, style = 'standard') {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const models = getModels();
  const model = models[0];
  const messages = buildMessages(page, style);

  if (provider === 'anthropic') {
    if (!process.env.LLM_API_KEY) {
      throw new Error('LLM_API_KEY is required for Anthropic.');
    }
    const client = new Anthropic({ apiKey: process.env.LLM_API_KEY });
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: messages.find((m) => m.role === 'system')?.content,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        yield event.delta.text;
      }
    }
    return;
  }

  // openai and ollama both use the OpenAI-compatible client
  const client = getOpenAIClient();
  const params = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
  };
  if (isOpenRouter(client.baseURL) && models.length > 1) {
    params.models = models;
  }
  const stream = await client.chat.completions.create(params);

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}

const RELATED_SYSTEM = `You suggest Wikipedia articles for further reading. Output only article titles, one per line. No numbering, bullets, explanations, or extra text.`;

async function suggestRelated(title, text) {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const models = getModels();
  const model = models[0];
  const userContent = `A reader just finished a narrative based on the Wikipedia article "${title}".

${(text || '').slice(0, 6000)}

Suggest 6 related Wikipedia article titles they might enjoy next. Prefer specific, interesting topics over generic ones.`;

  let content = '';
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.LLM_API_KEY });
    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      system: RELATED_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    content = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  } else {
    const client = getOpenAIClient();
    const params = {
      model,
      messages: [
        { role: 'system', content: RELATED_SYSTEM },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 300,
    };
    if (isOpenRouter(client.baseURL) && models.length > 1) {
      params.models = models;
    }
    const resp = await client.chat.completions.create(params);
    content = resp.choices[0]?.message?.content || '';
  }

  return content
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0 && l.length < 120)
    .slice(0, 8);
}

module.exports = { generateNarrative, suggestRelated, STYLE_IDS };
