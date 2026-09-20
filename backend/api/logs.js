
import { Router } from 'express';
import { db } from '../database/db.js';
import { addLog } from '../database/db.js';
import { addSseClient, clientCount } from '../monitor/hub.js';

const router = Router();

router.get('/', (req, res) => {
  const { source, level, limit, afterId } = req.query;
  let sql = 'SELECT * FROM logs';
  const params = [];
  const where = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (level) { where.push('level = ?'); params.push(level); }
  if (afterId) { where.push('id > ?'); params.push(afterId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  const rows = db.prepare(sql).all(...params);
  res.json(rows.reverse());
});

router.post('/', (req, res) => {
  const { level, source, message } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
  const id = addLog(level || 'info', source || 'system', String(message).slice(0, 4000));
  res.status(201).json({ ok: true, id });
});

/** SSE stream for real-time logs. */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  addSseClient(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ clients: clientCount() })}\n\n`);
  req.on('close', () => { /* hub cleans up */ });
});

export default router;
