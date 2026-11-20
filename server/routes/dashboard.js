/**
 * Web Dashboard & System Diagnostics Router
 * @file server/routes/dashboard.js
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const taskQueue = require('../queue');
const sessionManager = require('../session-manager');

const DASHBOARD_HTML_PATH = path.join(__dirname, '../views/dashboard.html');

function getDashboardHtml() {
  return fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
}

// 1. Health check & Diagnostics metrics endpoint
function buildDiagnosticsPayload() {
  return {
    status: 'ok',
    ...taskQueue.getMetrics(),
    activeSessions: sessionManager.activeSessions,
    totalActiveSessions: sessionManager.sessions.size,
    sessionList: sessionManager.listSessions(),
    historyCount: taskQueue.history.length,
    webModels: taskQueue.getAggregatedWebModels(),
    timestamp: new Date().toISOString()
  };
}

router.get('/status', (req, res) => {
  res.json(buildDiagnosticsPayload());
});

// Live Web Models Discovery Endpoint
router.get('/api/web-models', async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const provider = req.query.provider || null;
  let aggregated = taskQueue.getAggregatedWebModels();

  if ((refresh || aggregated.models.length === 0) && taskQueue.isBridgeReady()) {
    aggregated = await taskQueue.fetchWebModels({ provider, openMenu: true });
  }

  res.json({
    status: 'ok',
    connected: taskQueue.isBridgeReady(),
    ...aggregated
  });
});

// Alias for metrics
router.get('/metrics', (req, res) => {
  res.json(buildDiagnosticsPayload());
});

// Prompt History REST API
router.get('/api/history', (req, res) => {
  const result = taskQueue.getHistory({
    provider: req.query.provider || null,
    status: req.query.status || null,
    search: req.query.q || null,
    limit: req.query.limit
  });
  res.json({
    status: 'ok',
    ...result
  });
});

router.get('/api/history/:id', (req, res) => {
  const item = taskQueue.getHistoryItem(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'not_found', error: 'History item not found' });
  }
  res.json({ status: 'ok', item });
});

router.delete('/api/history/:id', (req, res) => {
  const deleted = taskQueue.deleteHistoryItem(req.params.id);
  res.json({ status: deleted ? 'ok' : 'not_found', deleted, id: req.params.id });
});

router.post('/api/history/clear', (req, res) => {
  const clearedCount = taskQueue.clearHistory();
  res.json({ status: 'ok', clearedCount });
});

router.delete('/api/history', (req, res) => {
  const clearedCount = taskQueue.clearHistory();
  res.json({ status: 'ok', clearedCount });
});

// Session list endpoint
router.get(['/sessions', '/api/sessions'], (req, res) => {
  res.json({
    status: 'ok',
    total: sessionManager.sessions.size,
    sessions: sessionManager.listSessions()
  });
});

// Delete specific session
router.delete(['/sessions/:id', '/api/sessions/:id'], (req, res) => {
  const success = sessionManager.deleteSession(req.params.id);
  res.json({ status: success ? 'ok' : 'not_found', deleted: success, id: req.params.id });
});

// Clear all sessions
router.post(['/sessions/clear', '/api/sessions/clear'], (req, res) => {
  const count = sessionManager.clearAllSessions();
  res.json({ status: 'ok', clearedCount: count });
});

// 2. Clear Queue API
router.post(['/queue/clear', '/api/queue/clear'], (req, res) => {
  const result = taskQueue.clearQueue(req.body?.reason || 'Cleared via Dashboard UI');
  res.json({
    status: 'ok',
    message: `Đã dọn sạch hàng đợi. Hủy ${result.cancelledCount} task chờ và ${result.cancelledRunning ? 1 : 0} task đang chạy.`,
    ...result
  });
});

// 3. Web Dashboard & Prompt History UI
router.get(['/', '/dashboard', '/history'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(getDashboardHtml());
});

module.exports = router;
