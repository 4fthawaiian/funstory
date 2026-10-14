const axios = require('axios');

const WIKIPEDIA_API = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const WIKIPEDIA_CONTENT_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'FunStory/1.0 (narrative-app@example.com)';

function extractTitle(query) {
  query = query.trim();
  if (query.startsWith('http://') || query.startsWith('https://')) {
    const url = new URL(query);
    let title = url.pathname;
    if (title.includes('/wiki/')) {
      title = title.split('/wiki/')[1];
    } else {
      title = title.split('/').filter(Boolean).pop() || '';
    }
    return decodeURIComponent(title).replace(/_/g, ' ');
  }
  return query;
}

function cleanText(text) {
  return text
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(query) {
  const title = extractTitle(query);
  const encoded = encodeURIComponent(title.replace(/ /g, '_'));

  const summaryRes = await axios.get(`${WIKIPEDIA_API}/${encoded}`, {
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: () => true,
  });

  const summaryData = summaryRes.data || {};

  if (summaryRes.status !== 200 || summaryData.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') {
    throw new Error(`Could not find a Wikipedia page for '${title}'.`);
  }

  const pageTitle = summaryData.titles?.canonical || title.replace(/ /g, '_');
  const summary = cleanText(summaryData.extract || '');
  const description = summaryData.description || '';

  const contentRes = await axios.get(WIKIPEDIA_CONTENT_API, {
    params: {
      action: 'query',
      format: 'json',
      prop: 'extracts',
      titles: pageTitle,
      explaintext: true,
      exlimit: 1,
      exintro: false,
      exsentences: 40,
    },
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT },
  });

  const pages = contentRes.data?.query?.pages || {};
  let fullExtract = '';
  for (const page of Object.values(pages)) {
    fullExtract = cleanText(page.extract || '');
  }

  return {
    title: summaryData.title || title,
    description,
    summary,
    extract: fullExtract,
    url: summaryData.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${pageTitle}`,
  };
}

// Deterministic related-topic discovery: editor-curated "See also" links
// first, then CirrusSearch "morelike" (same engine that powered RelatedPages)
async function relatedTitles(title) {
  const headers = { 'User-Agent': USER_AGENT };
  const [searchRes, sectionsRes] = await Promise.all([
    axios.get(WIKIPEDIA_CONTENT_API, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: `morelike:${title}`,
        srlimit: 10,
        srprop: '',
        format: 'json',
      },
      timeout: 15000,
      headers,
      validateStatus: () => true,
    }),
    axios.get(WIKIPEDIA_CONTENT_API, {
      params: { action: 'parse', page: title, prop: 'sections', format: 'json' },
      timeout: 15000,
      headers,
      validateStatus: () => true,
    }),
  ]);

  const morelike = (searchRes.data?.query?.search || []).map((s) => s.title);

  let seeAlso = [];
  const sections = sectionsRes.data?.parse?.sections || [];
  const saSection = sections.find((s) =>
    s.line.toLowerCase().includes('see also'),
  );
  if (saSection) {
    const linksRes = await axios.get(WIKIPEDIA_CONTENT_API, {
      params: {
        action: 'parse',
        page: title,
        prop: 'links',
        section: saSection.index,
        format: 'json',
      },
      timeout: 15000,
      headers,
      validateStatus: () => true,
    });
    seeAlso = (linksRes.data?.parse?.links || [])
      .filter((l) => l.ns === 0 && l['*'])
      .map((l) => l['*']);
  }

  // Meta/navigational pages make poor narratives
  const meta = /^(list|index|outline|timeline|glossary|bibliography|comparison) of /i;
  const usable = (t) => !meta.test(t);

  // Interleave the relevance-ranked morelike hits with curated See also links
  const seen = new Set([title.toLowerCase()]);
  const merged = [];
  const longer = Math.max(morelike.length, seeAlso.length);
  for (let i = 0; i < longer; i++) {
    for (const t of [morelike[i], seeAlso[i]]) {
      if (!t || !usable(t)) continue;
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(t);
      }
    }
  }
  return merged.slice(0, 10);
}

async function lookupTitle(title) {
  const res = await axios.get(
    `${WIKIPEDIA_API}/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    {
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    },
  );
  const data = res.data || {};
  if (res.status !== 200 || data.type === 'disambiguation') {
    return null;
  }
  return {
    title: data.title || title,
    description: data.description || '',
    url: data.content_urls?.desktop?.page || '',
  };
}

module.exports = { fetchPage, lookupTitle, relatedTitles };
