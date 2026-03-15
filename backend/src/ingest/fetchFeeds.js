'use strict';

// RSS feed ingestion module.
// Fetches the top 3 articles from each source, normalises them, deduplicates
// by URL, and upserts into the Supabase raw_articles table.

const Parser  = require('rss-parser');
const supabase = require('../db/client');

// ---------------------------------------------------------------------------
// Feed sources
// ---------------------------------------------------------------------------
const FEED_SOURCES = [
  { name: 'Globe and Mail', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/' },
  { name: 'CBC News',        url: 'https://www.cbc.ca/cmlink/rss-topstories' },
  { name: 'Toronto Star',    url: 'https://www.thestar.com/content/thestar/feed.rss' },
  { name: 'Reuters',         url: 'https://feeds.reuters.com/reuters/topNews' },
  { name: 'BBC News',        url: 'http://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'TechCrunch',      url: 'https://techcrunch.com/feed/' },
  { name: 'The Verge',       url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'Financial Post',  url: 'https://financialpost.com/feed' },
  { name: 'Ars Technica',    url: 'http://feeds.arstechnica.com/arstechnica/index' },
  { name: 'Bloomberg',       url: 'https://feeds.bloomberg.com/markets/news.rss' },
];

// Number of articles to pull from each feed
const ARTICLES_PER_FEED = 3;

// RSS parser instance with a 10-second request timeout
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'MirageNewsBot/1.0 (+https://mirage.news)',
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a formatted timestamp string for log messages.
 */
function ts() {
  return new Date().toISOString();
}

/**
 * Normalise a raw RSS item into a consistent article object.
 */
function normaliseItem(item, sourceName) {
  return {
    title:       (item.title || '').trim(),
    url:         (item.link  || item.guid || '').trim(),
    publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
    source:      sourceName,
    rawContent:  item.content || item.contentSnippet || item.summary || '',
  };
}

/**
 * Fetch up to ARTICLES_PER_FEED items from a single RSS feed.
 * Returns an empty array on failure so one broken feed cannot block others.
 */
async function fetchSingleFeed(source) {
  try {
    console.log(`[${ts()}] Fetching feed: ${source.name}`);
    const feed  = await parser.parseURL(source.url);
    const items = (feed.items || []).slice(0, ARTICLES_PER_FEED);
    const articles = items
      .map(item => normaliseItem(item, source.name))
      .filter(a => a.url); // drop items with no URL

    console.log(`[${ts()}] ${source.name}: fetched ${articles.length} article(s)`);
    return articles;
  } catch (err) {
    console.error(`[${ts()}] Failed to fetch feed "${source.name}": ${err.message}`);
    return [];
  }
}

/**
 * Deduplicate an array of articles by URL, keeping the first occurrence.
 */
function deduplicateByUrl(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

/**
 * Upsert an array of normalised articles into the Supabase raw_articles table.
 * Conflicts on `url` are ignored (do-nothing) so we never duplicate rows.
 * Returns the stored rows (those that were actually inserted).
 */
async function storeArticles(articles) {
  if (articles.length === 0) return [];

  const rows = articles.map(a => ({
    source:       a.source,
    title:        a.title,
    url:          a.url,
    published_at: a.publishedAt,
    raw_content:  a.rawContent,
  }));

  const { data, error } = await supabase
    .from('raw_articles')
    .upsert(rows, { onConflict: 'url', ignoreDuplicates: true })
    .select();

  if (error) {
    console.error(`[${ts()}] Supabase upsert error:`, error.message);
    throw error;
  }

  console.log(`[${ts()}] Stored ${(data || []).length} new article(s) in raw_articles`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all RSS feeds, normalise and deduplicate articles, then persist them
 * to Supabase.
 *
 * @returns {Promise<Array>} Array of stored raw_articles rows from Supabase.
 */
async function fetchAndStoreFeeds() {
  console.log(`[${ts()}] Starting RSS feed ingestion…`);

  // Fetch all feeds concurrently — individual failures are caught inside fetchSingleFeed
  const results = await Promise.all(FEED_SOURCES.map(fetchSingleFeed));

  // Flatten and deduplicate
  const allArticles = deduplicateByUrl(results.flat());
  console.log(`[${ts()}] Total unique articles after deduplication: ${allArticles.length}`);

  // Persist to Supabase
  const stored = await storeArticles(allArticles);
  console.log(`[${ts()}] Feed ingestion complete. ${stored.length} article(s) newly stored.`);

  return stored;
}

module.exports = { fetchAndStoreFeeds };
