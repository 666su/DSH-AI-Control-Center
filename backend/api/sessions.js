import { Router } from 'express';
import { listSessionTurns } from '../database/db.js';
import {
  startSessionWatcher, stopSessionWatcher, watcherStatus,
  testSessionTurnNotification
} from '../monitor/sessionWatcher.js';

const router = Router();

/** 最近的工作区对话结束记录。 */
router.get('/turns', (req, res) => {
  const { limit, workspace } = req.query || {};
  res.json(listSessionTurns({ limit, workspace }));
});

/** 会话监听器状态（跟踪的文件数、轮询次数、已推送 / 已跳过统计）。 */
router.get('/watcher', (req, res) => {
  res.json(watcherStatus());
});

/** 按最新配置重启监听器（修改 notify.sessionTurns 后生效）。 */
router.post('/restart', (req, res) => {
  stopSessionWatcher();
  const t = startSessionWatcher();
  res.json({ ok: true, running: !!t, ...watcherStatus() });
});

/** 发一条模拟的「对话结束」推送，用于验证通道。 */
router.post('/test', async (req, res) => {
  const result = await testSessionTurnNotification();
  res.json(result);
});

export default router;
