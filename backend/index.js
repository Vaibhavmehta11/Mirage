'use strict';

// Mirage backend — entry point.
// Load environment variables FIRST before any other module is required,
// since db/client.js and cache/client.js read from process.env at require time.
require('dotenv').config();

const express = require('express');
const router  = require('./src/api/routes');
const { startCronJob } = require('./src/cron/job');

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------
const app = express();

// Parse incoming JSON bodies
app.use(express.json());

// Health check — useful for uptime monitors and deployment checks
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount the digest API routes at the root path
app.use('/', router);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[Mirage] Server listening on port ${PORT}`);
  console.log(`[Mirage] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Mirage] API available at http://localhost:${PORT}/digest/today`);

  // Start the daily cron job (05:00 America/Toronto)
  startCronJob();
});

module.exports = app;
