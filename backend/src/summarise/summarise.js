'use strict';

// GPT-4o mini summarisation and topic-tagging module via OpenRouter.
// For each raw article:
//   1. Generates a 60-word factual summary.
//   2. Classifies the headline into one of: Tech, Business, World, Canada.
//   3. Upserts the result into the processed_articles Supabase table.

const OpenAI  = require('openai');
const supabase = require('../db/client');

// Use OpenRouter as the base URL — drop-in compatible with OpenAI SDK
const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://mirage.news',
    'X-Title':      'Mirage News App',
  },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL         = 'openai/gpt-4o-mini';
const MAX_RETRIES   = 2;
const RETRY_DELAY_MS = 1000;

const SUMMARY_SYSTEM_PROMPT =
  'You are a factual, neutral news summariser. Summarise the following article in exactly 60 words. ' +
  'Be concise, professional, and avoid editorialising. Output only the summary, nothing else.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call the OpenAI chat completions endpoint with simple retry logic.
 *
 * @param {Array}  messages  - Array of { role, content } objects.
 * @param {number} maxTokens - Upper bound on tokens in the response.
 * @returns {Promise<string>} The trimmed text content of the first choice.
 */
async function callGPT(messages, maxTokens = 200) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model:      MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      });
      return response.choices[0].message.content.trim();
    } catch (err) {
      lastError = err;
      console.error(`[${ts()}] OpenRouter call failed (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

/**
 * Generate a ~60-word summary for the given article content.
 */
async function generateSummary(article) {
  const userContent = `Title: ${article.title}\n\n${article.raw_content || article.title}`;
  return callGPT(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user',   content: userContent },
    ],
    150
  );
}

/**
 * Classify the article headline into one of: Tech, Business, World, Canada.
 */
async function generateTopicTag(headline) {
  const prompt =
    `Classify this news headline into exactly one of these topics: Tech, Business, World, Canada. ` +
    `Tag Canada if the story is primarily about Canada; otherwise tag by subject matter. ` +
    `Output only the topic word, nothing else. Headline: ${headline}`;

  const tag = await callGPT(
    [{ role: 'user', content: prompt }],
    10
  );

  // Sanitise — only accept known tags, default to 'World'
  const valid = ['Tech', 'Business', 'World', 'Canada'];
  return valid.includes(tag) ? tag : 'World';
}

/**
 * Check which raw_article_ids already have processed records in Supabase.
 * Returns a Set of already-processed raw_article_ids (as strings).
 */
async function getAlreadyProcessedIds(rawArticleIds) {
  if (rawArticleIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from('processed_articles')
    .select('raw_article_id')
    .in('raw_article_id', rawArticleIds);

  if (error) {
    console.error(`[${ts()}] Error checking processed_articles:`, error.message);
    return new Set(); // proceed and let upsert handle conflicts
  }

  return new Set((data || []).map(r => r.raw_article_id));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarise and tag a batch of raw articles, storing results in processed_articles.
 *
 * @param {Array} rawArticles - Rows from raw_articles table.
 * @returns {Promise<Array>}  Inserted/existing processed_articles rows.
 */
async function summariseArticles(rawArticles) {
  if (!rawArticles || rawArticles.length === 0) {
    console.log(`[${ts()}] No raw articles to summarise.`);
    return [];
  }

  console.log(`[${ts()}] Starting summarisation for ${rawArticles.length} article(s)…`);

  // Identify articles that are already processed so we skip them
  const alreadyDone = await getAlreadyProcessedIds(rawArticles.map(a => a.id));
  const toProcess   = rawArticles.filter(a => !alreadyDone.has(a.id));

  console.log(`[${ts()}] ${toProcess.length} article(s) need summarisation (${alreadyDone.size} already done).`);

  const processedRows = [];

  for (const article of toProcess) {
    try {
      console.log(`[${ts()}] Summarising: "${article.title}"`);

      const summary  = await generateSummary(article);
      const topicTag = await generateTopicTag(article.title);

      console.log(`[${ts()}] Tagged as: ${topicTag}`);

      // Insert into processed_articles (score starts at 0, ranking will update it)
      const { data, error } = await supabase
        .from('processed_articles')
        .insert({
          raw_article_id: article.id,
          headline:       article.title,
          summary,
          topic_tag:      topicTag,
          score:          0,
        })
        .select()
        .single();

      if (error) {
        console.error(`[${ts()}] Failed to insert processed article for "${article.title}":`, error.message);
        continue;
      }

      processedRows.push(data);
      console.log(`[${ts()}] Stored processed article id=${data.id}`);
    } catch (err) {
      console.error(`[${ts()}] Error processing article "${article.title}":`, err.message);
      // Continue to next article — one failure must not stop the pipeline
    }
  }

  // Also return already-processed records so the ranker has a full picture
  if (alreadyDone.size > 0) {
    const { data: existing } = await supabase
      .from('processed_articles')
      .select('*')
      .in('raw_article_id', rawArticles.map(a => a.id));

    return existing || processedRows;
  }

  console.log(`[${ts()}] Summarisation complete. ${processedRows.length} article(s) processed.`);
  return processedRows;
}

module.exports = { summariseArticles };
