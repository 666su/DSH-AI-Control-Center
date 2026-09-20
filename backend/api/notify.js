
import { Router } from 'express';
import { getNotifyConfig, saveNotifyConfig, sendNotification } from '../services/notifyService.js';

const router = Router();

router.get('/config', (req, res) => {
  res.json(getNotifyConfig());
});

router.post('/config', (req, res) => {
  res.json(saveNotifyConfig(req.body || {}));
});

router.post('/test', async (req, res) => {
  const result = await sendNotification('test', { message: 'control-center test notification' });
  res.json(result);
});

export default router;
