'use strict';

// Upstash Redis client singleton (HTTP-based, works in any Node environment).
// dotenv is loaded by index.js at startup, so env vars are available here.

const { Redis } = require('@upstash/redis');

const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
  throw new Error(
    'Missing Upstash Redis credentials. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in your .env file.'
  );
}

// Create and export a single shared Redis instance.
const redis = new Redis({
  url:   redisUrl,
  token: redisToken,
});

module.exports = redis;
