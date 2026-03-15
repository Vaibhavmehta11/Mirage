-- Mirage AI News Digest — Supabase Schema
-- Run this in the Supabase SQL editor to initialise the database.

-- ---------------------------------------------------------------------------
-- raw_articles
-- Stores articles ingested directly from RSS feeds before any AI processing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_articles (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  url          TEXT        NOT NULL UNIQUE,
  published_at TIMESTAMPTZ,
  raw_content  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index on url for fast upsert conflict resolution
CREATE INDEX IF NOT EXISTS idx_raw_articles_url
  ON raw_articles (url);

-- ---------------------------------------------------------------------------
-- processed_articles
-- Stores GPT-4o mini summaries, topic tags, and computed ranking scores.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_articles (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_article_id UUID        NOT NULL REFERENCES raw_articles (id) ON DELETE CASCADE,
  headline       TEXT        NOT NULL,
  summary        TEXT        NOT NULL,
  topic_tag      TEXT        NOT NULL,
  score          NUMERIC     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick look-ups by the parent raw article
CREATE INDEX IF NOT EXISTS idx_processed_articles_raw_article_id
  ON processed_articles (raw_article_id);

-- ---------------------------------------------------------------------------
-- daily_digest
-- One row per calendar day — stores the final ranked JSON story list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_digest (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE    NOT NULL UNIQUE,
  stories    JSONB   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index on date for fast lookups by the API
CREATE INDEX IF NOT EXISTS idx_daily_digest_date
  ON daily_digest (date);
