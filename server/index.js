require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const {
  fetchPage,
  lookupTitle,
  relatedTitles,
  extractTitle,
  randomTitle,
  featuredTitle,
} = require('./wiki');
const {
  generateNarrative,
  suggestRelated,
  STYLE_IDS,
  LENGTH_IDS,
} = require('./narrative');

// Story ids are "<slug>" for the default telling and "<slug>@<variant>" for
// variants, where variant is "<style>" or "<style>-<length>" — e.g.
// "marie-curie@bedtime" or "marie-curie@bedtime-short".
const STORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}(@[a-z0-9-]{1,30})?$/;

const app = express();
const PORT = process.env.PORT || 8765;
const HOST = process.env.HOST || '0.0.0.0';

const STORIES_DIR = path.join(__dirname, 'stories');
fs.mkdirSync(STORIES_DIR, { recursive: true });

// Only the VPS tunnel peer may carry a trusted X-Forwarded-For; a spoofed
// XFF from a public visitor can never skip ahead of their real IP.
app.set('trust proxy', '10.8.0.1');

app.use(
  cors({
    exposedHeaders: ['X-Story-Id', 'X-Story-Cached', 'X-Story-Title'],
  }),
);
app.use(express.json());

// Requests that never went through the public nginx (localhost/LAN/VPN
// direct hits) or carry the bypass key are exempt — so local testing is
// never throttled.
const PRIVATE_IP = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1|f[cd]|fe80)/i;
function isLocalRequest(req) {
  const ip = (req.ip || '').replace(/^::ffff:/, '');
  return PRIVATE_IP.test(ip);
}
function hasBypassKey(req) {
  const key = process.env.RATE_LIMIT_BYPASS_KEY;
  return !!key && req.get('x-funstory-key') === key;
}

const llmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_PER_HOUR || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isLocalRequest(req) || hasBypassKey(req),
  handler: (_req, res) =>
    res.status(429).json({
      detail: 'Too many story requests from your address — try again later.',
    }),
});

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

app.post('/api/narrate', llmLimiter, async (req, res) => {
  let query = (req.body.query || '').trim();
  const style = STYLE_IDS.includes(req.body.style) ? req.body.style : 'standard';
  const length = LENGTH_IDS.includes(req.body.length)
    ? req.body.length
    : 'medium';
  const variant =
    style === 'standard' && length === 'medium'
      ? ''
      : `${style}${length === 'medium' ? '' : `-${length}`}`;
  const suffix = variant ? `@${variant}` : '';
  const regen = req.body.regen === true;

  if (!query && req.body.random === true) {
    try {
      query = await randomTitle();
    } catch (err) {
      return res.status(502).json({ detail: err.message });
    }
  }
  if (!query) {
    return res.status(400).json({ detail: 'query is required' });
  }

  function setStoryHeaders(slug) {
    res.setHeader('X-Story-Id', slug);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  function serveCached(file, slug) {
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    setStoryHeaders(slug);
    res.setHeader('X-Story-Cached', '1');
    res.setHeader('X-Story-Title', encodeURIComponent(story.title || ''));
    res.end(story.text);
  }

  // Fast path: a story filed under the query's own slug needs zero
  // Wikipedia calls — pure disk read.
  const querySlug = slugify(extractTitle(query)) + suffix;
  if (!regen && fs.existsSync(storyFile(querySlug))) {
    try {
      return serveCached(storyFile(querySlug), querySlug);
    } catch {
      // Corrupt file — fall through and regenerate
    }
  }

  let page;
  try {
    page = await fetchPage(query);
  } catch (err) {
    const status = err.message.includes('Could not find') ? 404 : 502;
    return res.status(status).json({ detail: err.message });
  }

  const slug = slugify(page.title) + suffix;
  const file = storyFile(slug);

  // Second chance: the canonical title may differ from the query slug
  // (aliases, URLs) but the story already exists under it.
  if (!regen && fs.existsSync(file)) {
    try {
      return serveCached(file, slug);
    } catch {
      // Corrupt story file — fall through and regenerate
    }
  }

  setStoryHeaders(slug);
  res.setHeader('X-Story-Title', encodeURIComponent(page.title || ''));

  let text = '';
  try {
    for await (const chunk of generateNarrative(page, style, length)) {
      text += chunk;
      res.write(chunk);
      // Flush to ensure streaming reaches the client immediately
      if (res.flush) res.flush();
    }
    res.end();
    try {
      let prior = {};
      try {
        prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // no existing story — fresh write
      }
      // Style variants share the canonical story's related topics when present
      if (!prior.related && suffix) {
        try {
          prior.related = JSON.parse(
            fs.readFileSync(storyFile(slugify(page.title)), 'utf8'),
          ).related;
        } catch {
          // no canonical story yet — related generates lazily
        }
      }
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            slug,
            title: page.title,
            style,
            length,
            url: page.url,
            text,
            related: prior.related,
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
    const quotaExceeded = err.status === 429 || /\b429\b/.test(err.message);
    const friendly = quotaExceeded
      ? 'The free story quota for today is exhausted — try again tomorrow.'
      : `LLM error: ${err.message}`;
    // If headers already sent, close the stream; otherwise return JSON error
    if (res.headersSent) {
      res.write(`\n\n[Error: ${friendly}]`);
      return res.end();
    }
    return res.status(quotaExceeded ? 429 : 502).json({ detail: friendly });
  }
});

app.get('/api/story/:slug', (req, res) => {
  const { slug } = req.params;
  if (!STORY_ID_RE.test(slug)) {
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

app.get('/api/story/:slug/related', llmLimiter, async (req, res) => {
  const { slug } = req.params;
  if (!STORY_ID_RE.test(slug)) {
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
    // Wikipedia-derived suggestions are free; only fall back to the LLM
    // when they come up short.
    let candidates = await relatedTitles(story.title).catch(() => []);
    if (candidates.length < 3) {
      const llm = await suggestRelated(story.title, story.text || '').catch(
        () => [],
      );
      candidates = [...candidates, ...llm];
    }
    // Validate in batches of 6 and stop once we have 5 — most candidates
    // resolve, so this rarely needs a second batch.
    const seen = new Set();
    const validated = [];
    for (let i = 0; i < candidates.length && validated.length < 5; i += 6) {
      const batch = await Promise.all(
        candidates.slice(i, i + 6).map((c) => lookupTitle(c).catch(() => null)),
      );
      for (const r of batch) {
        if (!r) continue;
        const key = r.title.toLowerCase();
        if (seen.has(key) || slugify(r.title) === slug) continue;
        seen.add(key);
        validated.push(r);
        if (validated.length >= 5) break;
      }
    }
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

app.get('/api/stories', (_req, res) => {
  try {
    const stories = fs
      .readdirSync(STORIES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(
            fs.readFileSync(path.join(STORIES_DIR, f), 'utf8'),
          );
          return {
            slug: s.slug || f.slice(0, -5),
            title: s.title,
            style: s.style || 'standard',
            createdAt: s.createdAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 12);
    res.json({ stories });
  } catch {
    res.json({ stories: [] });
  }
});

let featuredCache = { date: '', title: null };
app.get('/api/featured', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (featuredCache.date === today && featuredCache.title) {
    return res.json(featuredCache);
  }
  try {
    const title = await featuredTitle();
    featuredCache = { date: today, title };
    res.json(featuredCache);
  } catch (err) {
    res.status(502).json({ detail: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Serve the Flutter web build, with SPA fallback to index.html.
// /s/<slug> gets per-story OG meta injected so share links unfurl nicely.
const webDir = path.join(__dirname, '..', 'funstory_flutter', 'build', 'web');
const indexHtmlPath = path.join(webDir, 'index.html');
const indexHtml = fs.existsSync(indexHtmlPath)
  ? fs.readFileSync(indexHtmlPath, 'utf8')
  : '';

const escapeAttr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function ogTags(story, slug, req) {
  const variant = slug.includes('@') ? ` — ${slug.split('@')[1]}` : '';
  const desc = (story.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const url = `https://${req.get('host')}/s/${slug}`;
  return `
    <meta property="og:title" content="${escapeAttr(story.title)}${escapeAttr(variant)} — FunStory" />
    <meta property="og:description" content="${escapeAttr(desc)}…" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeAttr(url)}" />
    <meta name="twitter:card" content="summary" />
`;
}

app.use(express.static(webDir));
app.get('*', (req, res) => {
  if (!indexHtml) return res.status(404).send('not found');
  let html = indexHtml;
  const m = req.path.match(/^\/s\/([^/?#]+)/);
  if (m) {
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (STORY_ID_RE.test(slug)) {
      const file = storyFile(slug);
      if (fs.existsSync(file)) {
        try {
          const story = JSON.parse(fs.readFileSync(file, 'utf8'));
          html = indexHtml.replace('</head>', `${ogTags(story, slug, req)}  </head>`);
        } catch {
          // corrupt file — serve plain index
        }
      }
    }
  }
  res.type('html').send(html);
});

// Warm today's featured-article story so there is always fresh cached
// content (costs one LLM call per day at most).
async function warmFeatured() {
  try {
    const title = await featuredTitle();
    const page = await fetchPage(title);
    const slug = slugify(page.title);
    if (fs.existsSync(storyFile(slug))) return;
    let text = '';
    for await (const chunk of generateNarrative(page)) {
      text += chunk;
    }
    fs.writeFileSync(
      storyFile(slug),
      JSON.stringify(
        {
          slug,
          title: page.title,
          style: 'standard',
          url: page.url,
          text,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`Warmed featured story: ${slug}`);
  } catch (err) {
    console.error('Featured warm-up failed:', err.message);
  }
}

warmFeatured();
setInterval(warmFeatured, 24 * 3600 * 1000);

validateConfig();

app.listen(PORT, HOST, () => {
  console.log(`FunStory server running on http://${HOST}:${PORT}`);
});
