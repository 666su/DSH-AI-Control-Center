
import { Router } from 'express';
import { snapshot, getLastSnapshot, getHistory } from '../services/systemMonitor.js';

const router = Router();

router.get('/', async (req, res) => {
  // force fresh snapshot on demand (still cached per monitor loop)
  const snap = await snapshot();
  res.json(snap);
});

router.get('/last', (req, res) => {
  res.json(getLastSnapshot() || null);
});

router.get('/history', (req, res) => {
  const hours = Number(req.query.hours) || 6;
  const limit = Math.min(Number(req.query.limit) || 2000, 10000);
  res.json(getHistory(hours, limit));
});

export default router;
