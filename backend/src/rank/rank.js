'use strict';

// Ranking module.
// Scores each processed article using source authority and recency, applies a
// Canada-story boost, selects the top 10 for the daily digest, and persists
// the result to Supabase.

const supabase = require('../db/client');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Source authority weights (higher = more trusted / prominent) */
const SOURCE_WEIGHTS = {
  'Globe and Mail': 5,
  'CBC News':       5,
  'Financial Post': 4,
  'Reuters':        4,
  'BBC News':       3,
  'TechCrunch':     3,
  'The Verge':      3,
  'Toronto Star':   3,
  'Ars Technica':   2,
  'Bloomberg':      4,
};

const DEFAULT_WEIGHT      = 2;   // fallback for unknown sources
const DIGEST_SIZE         = 10;  // total stories per digest
const MIN_CANADA_STORIES  = 2;   // guaranteed minimum Canada stories in digest
const CANADA_BOOST        = 1.3; // score multiplier for Canadian stories

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

/**
 * Compute a recency score in [0, 10].
 * Articles published within the last 24 h get 10; linear decay to 0 at 48 h.
 */
function recencyScore(publishedAt) {
  const now      = Date.now();
  const pub      = new Date(publishedAt).getTime();
  const hoursOld = (now - pub) / (1000 * 60 * 60);
  return Math.max(0, 1 - hoursOld / 48) * 10;
}

/**
 * Compute the total ranking score for a processed article.
 */
function computeScore(processedArticle, rawArticle) {
  const authority = SOURCE_WEIGHTS[rawArticle.source] ?? DEFAULT_WEIGHT;
  const recency   = recencyScore(rawArticle.published_at || rawArticle.created_at);
  const canadaMultiplier = processedArticle.topic_tag === 'Canada' ? CANADA_BOOST : 1.0;

  return (recency + authority) * canadaMultiplier;
}

/**
 * Select the top DIGEST_SIZE articles, guaranteeing MIN_CANADA_STORIES slots
 * for Canada-tagged articles (if that many exist).
 *
 * @param {Array} scored - Articles sorted by score descending, each having a
 *                         `score` and `topic_tag` field.
 * @returns {Array} Up to DIGEST_SIZE articles.
 */
function selectTopStories(scored) {
  const canadaStories  = scored.filter(a => a.topic_tag === 'Canada');
  const otherStories   = scored.filter(a => a.topic_tag !== 'Canada');

  // Guaranteed Canada slots (up to MIN_CANADA_STORIES)
  const canadaSlots = canadaStories.slice(0, MIN_CANADA_STORIES);
  // Remaining slots filled from the rest (sorted by score)
  const remaining   = DIGEST_SIZE - canadaSlots.length;

  // Pool of non-guaranteed articles: remaining Canada + all others, re-sorted
  const pool = [
    ...canadaStories.slice(MIN_CANADA_STORIES),
    ...otherStories,
  ].sort((a, b) => b.score - a.score);

  return [...canadaSlots, ...pool.slice(0, remaining)];
}

/**
 * Format a combined record (processed + raw) into the story shape used by the
 * API and stored in daily_digest.
 */
function formatStory(processedArticle, rawArticle) {
  return {
    id:          processedArticle.id,
    headline:    processedArticle.headline,
    summary:     processedArticle.summary,
    topic:       processedArticle.topic_tag,
    source:      rawArticle.source,
    url:         rawArticle.url,
    publishedAt: rawArticle.published_at || rawArticle.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score all processed articles, select the top 10 for today's digest, update
 * scores in Supabase, and upsert the digest row.
 *
 * @param {Array} processedArticles - Rows from processed_articles.
 * @param {Map}   rawArticlesMap    - Map<raw_article_id, raw_article row>.
 * @returns {Promise<Array>}         The stories array saved to daily_digest.
 */
async function rankAndStoreDigest(processedArticles, rawArticlesMap) {
  if (!processedArticles || processedArticles.length === 0) {
    console.log(`[${ts()}] No processed articles to rank.`);
    return [];
  }

  console.log(`[${ts()}] Ranking ${processedArticles.length} processed article(s)…`);

  // ---------------------------------------------------------------------------
  // 0. If rawArticlesMap not provided, fetch from Supabase
  // ---------------------------------------------------------------------------
  if (!rawArticlesMap) {
    const rawIds = processedArticles.map(a => a.raw_article_id);
    const { data, error } = await supabase
      .from('raw_articles')
      .select('*')
      .in('id', rawIds);

    if (error) {
      console.error(`[${ts()}] Failed to fetch raw articles for ranking:`, error.message);
      throw error;
    }

    rawArticlesMap = new Map((data || []).map(r => [r.id, r]));
    console.log(`[${ts()}] Loaded ${rawArticlesMap.size} raw articles for scoring.`);
  }

  // ---------------------------------------------------------------------------
  // 1. Compute scores and join with raw article data
  // ---------------------------------------------------------------------------
  const scored = [];

  for (const pa of processedArticles) {
    const raw = rawArticlesMap.get(pa.raw_article_id);
    if (!raw) {
      console.warn(`[${ts()}] No raw article found for processed id=${pa.id}, skipping.`);
      continue;
    }

    const score = computeScore(pa, raw);
    scored.push({ ...pa, score, _raw: raw });
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // ---------------------------------------------------------------------------
  // 2. Update scores in processed_articles table
  // ---------------------------------------------------------------------------
  console.log(`[${ts()}] Updating computed scores in processed_articles…`);

  for (const article of scored) {
    const { error } = await supabase
      .from('processed_articles')
      .update({ score: article.score })
      .eq('id', article.id);

    if (error) {
      console.error(`[${ts()}] Failed to update score for id=${article.id}:`, error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Select top stories with Canada guarantee
  // ---------------------------------------------------------------------------
  const topStories = selectTopStories(scored);
  console.log(`[${ts()}] Selected ${topStories.length} top story/stories for today's digest.`);

  // ---------------------------------------------------------------------------
  // 4. Format the stories array
  // ---------------------------------------------------------------------------
  const stories = topStories.map(a => formatStory(a, a._raw));

  // ---------------------------------------------------------------------------
  // 5. Upsert into daily_digest for today's date
  // ---------------------------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const { error: digestError } = await supabase
    .from('daily_digest')
    .upsert(
      { date: today, stories },
      { onConflict: 'date' }
    );

  if (digestError) {
    console.error(`[${ts()}] Failed to upsert daily_digest:`, digestError.message);
    throw digestError;
  }

  console.log(`[${ts()}] Daily digest for ${today} saved with ${stories.length} story/stories.`);
  return stories;
}

module.exports = { rankAndStoreDigest };
