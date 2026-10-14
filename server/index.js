require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { fetchPage, lookupTitle } = require('./wiki');
const { generateNarrative, suggestRelated } = require('./narrative');

const app = express();
const PORT = process.env.PORT || 8765;
const HOST = process.env.HOST || '0.0.0.0';

const STORIES_DIR = path.join(__dirname, 'stories');
fs.mkdirSync(STORIES_DIR, { recursive: true });

app.use(cors({ exposedHeaders: ['X-Story-Id', 'X-Story-Cached'] }));
app.use(express.json());

function slugify(title) {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || crypto.randomBytes(5).toString('hex');
}

const storyFile = (slug) => path.join(STORIES_DIR, `${slug}.json`);

function validateConfig() {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  if ((provider === 'openai' || provider === 'anthropic') && !process.env.LLM_API_KEY) {
    throw new Error(`LLM_API_KEY is required when LLM_PROVIDER=${provider}`);
  }
}

app.post('/api/narrate', async (req, res) => {
  const query = (req.body.query || '').trim();
  if (!query) {
    return res.status(400).json({ detail: 'query is required' });
  }

  let page;
  try {
    page = await fetchPage(query);
  } catch (err) {
    const status = err.message.includes('Could not find') ? 404 : 502;
    return res.status(status).json({ detail: err.message });
  }

  const slug = slugify(page.title);
  const file = storyFile(slug);
  const regen = req.body.regen === true;

  res.setHeader('X-Story-Id', slug);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!regen && fs.existsSync(file)) {
    try {
      const story = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.setHeader('X-Story-Cached', '1');
      return res.end(story.text);
    } catch {
      // Corrupt story file — fall through and regenerate
    }
  }

  let text = '';
  try {
    for await (const chunk of generateNarrative(page)) {
      text += chunk;
      res.write(chunk);
      // Flush to ensure streaming reaches the client immediately
      if (res.flush) res.flush();
    }
    res.end();
    try {
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            slug,
            title: page.title,
            url: page.url,
            text,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error('Failed to save story:', err);
    }
  } catch (err) {
    console.error('LLM error:', err);
    // If headers already sent, close the stream; otherwise return JSON error
    if (res.headersSent) {
      res.write(`\n\n[Error: ${err.message}]`);
      return res.end();
    }
    return res.status(502).json({ detail: `LLM error: ${err.message}` });
  }
});

app.get('/api/story/:slug', (req, res) => {
  const { slug } = req.params;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    return res.status(400).json({ detail: 'invalid story id' });
  }
  const file = storyFile(slug);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ detail: 'story not found' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    res.status(500).json({ detail: 'corrupt story file' });
  }
});

app.get('/api/story/:slug/related', async (req, res) => {
  const { slug } = req.params;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    return res.status(400).json({ detail: 'invalid story id' });
  }
  const file = storyFile(slug);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ detail: 'story not found' });
  }
  let story;
  try {
    story = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return res.status(500).json({ detail: 'corrupt story file' });
  }
  if (Array.isArray(story.related) && story.related.length) {
    return res.json({ related: story.related });
  }
  try {
    const candidates = await suggestRelated(story.title, story.text || '');
    const validated = (await Promise.all(candidates.map(lookupTitle)))
      .filter(Boolean)
      .filter((r) => slugify(r.title) !== slug)
      .slice(0, 5);
    story.related = validated;
    try {
      fs.writeFileSync(file, JSON.stringify(story, null, 2));
    } catch (err) {
      console.error('Failed to persist related stories:', err);
    }
    res.json({ related: validated });
  } catch (err) {
    console.error('Related suggestion error:', err);
    res.status(502).json({ detail: `Could not generate suggestions: ${err.message}` });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Serve the Flutter web build, with SPA fallback to index.html
const webDir = path.join(__dirname, '..', 'funstory_flutter', 'build', 'web');
app.use(express.static(webDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDir, 'index.html'));
});

validateConfig();

app.listen(PORT, HOST, () => {
  console.log(`FunStory server running on http://${HOST}:${PORT}`);
});
