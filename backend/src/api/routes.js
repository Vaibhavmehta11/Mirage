'use strict';

// Express router — public API endpoints for the Mirage digest.
//
// GET /digest/today
//   Returns today's ranked story list. Checks Redis cache first, then
//   Supabase. Falls back to yesterday's digest with stale:true if today's
//   digest has not yet been generated.

const express  = require('express');
const redis    = require('../cache/client');
const supabase = require('../db/client');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

/**
 * Return a date string in 'YYYY-MM-DD' format, offset by `dayOffset` days
 * from today (0 = today, -1 = yesterday).
 */
function dateString(dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * Redis cache key for a given date string.
 */
function cacheKey(date) {
  return `digest:${date}`;
}

/**
 * Fetch the digest for `date` from Supabase.
 * Returns the row object or null if not found.
 */
async function fetchDigestFromDB(date) {
  const { data, error } = await supabase
    .from('daily_digest')
    .select('*')
    .eq('date', date)
    .maybeSingle();

  if (error) {
    console.error(`[${ts()}] Supabase error fetching digest for ${date}:`, error.message);
    return null;
  }

  return data || null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /digest/today
 *
 * Response shape:
 *   {
 *     date: 'YYYY-MM-DD',
 *     stories: [ { id, headline, summary, topic, source, url, publishedAt } ],
 *     stale?: true   // present only when falling back to yesterday's digest
 *   }
 */
router.get('/digest/today', async (req, res) => {
  const today     = dateString(0);
  const yesterday = dateString(-1);

  try {
    // ------------------------------------------------------------------
    // 1. Redis cache check for today
    // ------------------------------------------------------------------
    const cached = await redis.get(cacheKey(today));

    if (cached) {
      console.log(`[${ts()}] Cache HIT for ${today}`);
      const payload = typeof cached === 'string' ? JSON.parse(cached) : cached;
      return res.json(payload);
    }

    console.log(`[${ts()}] Cache MISS for ${today} — querying Supabase`);

    // ------------------------------------------------------------------
    // 2. Supabase lookup for today
    // ------------------------------------------------------------------
    const todayDigest = await fetchDigestFromDB(today);

    if (todayDigest) {
      const payload = {
        date:    todayDigest.date,
        stories: todayDigest.stories,
      };

      // Cache for ~23 hours so the next cron run can overwrite
      await redis.set(cacheKey(today), JSON.stringify(payload), { ex: 23 * 3600 });
      console.log(`[${ts()}] Cached digest for ${today} in Redis (TTL 23h)`);

      return res.json(payload);
    }

    // ------------------------------------------------------------------
    // 3. Fallback to yesterday's digest (stale)
    // ------------------------------------------------------------------
    console.log(`[${ts()}] No digest for ${today} — checking ${yesterday}`);
    const yesterdayDigest = await fetchDigestFromDB(yesterday);

    if (yesterdayDigest) {
      const payload = {
        date:    yesterdayDigest.date,
        stories: yesterdayDigest.stories,
        stale:   true,
      };
      return res.json(payload);
    }

    // ------------------------------------------------------------------
    // 4. Nothing available
    // ------------------------------------------------------------------
    return res.status(404).json({ message: 'No digest available yet' });

  } catch (err) {
    console.error(`[${ts()}] Unhandled error in GET /digest/today:`, err.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
