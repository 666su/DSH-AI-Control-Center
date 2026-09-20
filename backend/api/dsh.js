
import { Router } from 'express';
import { getStatus, restart, control, start, stop } from '../services/dshService.js';

const router = Router();

router.get('/status', async (req, res) => {
  res.json(await getStatus());
});

router.post('/restart', async (req, res) => {
  const result = await restart();
  res.status(result.ok ? 200 : 500).json(result);
});

router.post('/start', async (req, res) => {
  const result = await start();
  res.status(result.ok ? 200 : 500).json(result);
});

router.post('/stop', async (req, res) => {
  const result = await stop();
  res.status(result.ok ? 200 : 500).json(result);
});

router.post('/control', async (req, res) => {
  const { action } = req.body || {};
  if (!['pause', 'resume'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'action must be pause or resume' });
  }
  res.json(await control(action));
});

export default router;
