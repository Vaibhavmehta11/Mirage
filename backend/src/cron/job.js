'use strict';

// Cron job — runs the full ingestion → summarisation → ranking pipeline
// every day at 05:00 America/Toronto time.

const cron     = require('node-cron');
const redis    = require('../cache/client');
const supabase = require('../db/client');

const { fetchAndStoreFeeds }   = require('../ingest/fetchFeeds');
const { summariseArticles }    = require('../summarise/summarise');
const { rankAndStoreDigest }   = require('../rank/rank');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formatted timestamp for cron log lines.
 */
function cronTs() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function log(msg) {
  console.log(`[CRON ${cronTs()}] ${msg}`);
}

function logErr(msg, err) {
  console.error(`[CRON ${cronTs()}] ERROR — ${msg}:`, err?.message || err);
}

/**
 * Today's date as 'YYYY-MM-DD'.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Redis cache key for the digest.
 */
function cacheKey(date) {
  return `digest:${date}`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the full pipeline:
 *   1. Fetch & store RSS articles
 *   2. Summarise with GPT-4o mini
 *   3. Rank & store digest
 *   4. Cache result in Redis
 */
async function runPipeline() {
  log('Pipeline starting…');

  // ---- Step 1: Ingest RSS feeds ------------------------------------------
  let rawArticles;
  try {
    log('Step 1 — Fetching RSS feeds…');
    rawArticles = await fetchAndStoreFeeds();
    log(`Step 1 complete — ${rawArticles.length} article(s) stored.`);
  } catch (err) {
    logErr('Step 1 (fetchAndStoreFeeds) failed', err);
    // Cannot continue without raw articles
    return;
  }

  if (rawArticles.length === 0) {
    log('No new articles ingested — skipping summarisation and ranking.');
    return;
  }

  // ---- Step 2: Summarise ---------------------------------------------------
  let processedArticles;
  try {
    log('Step 2 — Summarising articles with GPT-4o mini…');
    processedArticles = await summariseArticles(rawArticles);
    log(`Step 2 complete — ${processedArticles.length} article(s) processed.`);
  } catch (err) {
    logErr('Step 2 (summariseArticles) failed', err);
    return;
  }

  if (processedArticles.length === 0) {
    log('No processed articles — skipping ranking.');
    return;
  }

  // ---- Step 3: Rank & store digest ----------------------------------------
  let stories;
  try {
    log('Step 3 — Ranking articles and building digest…');

    // Build a Map of raw_article_id → raw_article for the ranker
    const rawMap = new Map(rawArticles.map(a => [a.id, a]));

    // If rawMap is missing some ids (because they were previously stored),
    // fetch them from Supabase so the ranker can access their metadata.
    const missingIds = processedArticles
      .map(p => p.raw_article_id)
      .filter(id => !rawMap.has(id));

    if (missingIds.length > 0) {
      const { data: extra } = await supabase
        .from('raw_articles')
        .select('*')
        .in('id', missingIds);

      (extra || []).forEach(a => rawMap.set(a.id, a));
    }

    stories = await rankAndStoreDigest(processedArticles, rawMap);
    log(`Step 3 complete — digest contains ${stories.length} story/stories.`);
  } catch (err) {
    logErr('Step 3 (rankAndStoreDigest) failed', err);
    return;
  }

  // ---- Step 4: Cache in Redis ----------------------------------------------
  try {
    log('Step 4 — Caching digest in Redis…');
    const payload = { date: today(), stories };
    await redis.set(cacheKey(today()), JSON.stringify(payload), { ex: 23 * 3600 });
    log(`Step 4 complete — digest cached under key "${cacheKey(today())}" (TTL 23h).`);
  } catch (err) {
    logErr('Step 4 (Redis cache) failed', err);
    // Non-fatal — API will fall back to Supabase on cache miss
  }

  log('Pipeline finished successfully.');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register and start the cron job.
 * Schedule: every day at 05:00 America/Toronto (Eastern Time).
 */
function startCronJob() {
  log('Registering cron job (schedule: 0 5 * * *, timezone: America/Toronto)…');

  cron.schedule('0 5 * * *', async () => {
    log('Cron triggered — starting pipeline run.');
    try {
      await runPipeline();
    } catch (err) {
      // Top-level safety net — the server must NOT crash due to a cron error.
      logErr('Unhandled error in cron pipeline (server continues running)', err);
    }
  }, {
    timezone: 'America/Toronto',
  });

  log('Cron job registered. Next run: 05:00 America/Toronto.');
}

module.exports = { startCronJob };
