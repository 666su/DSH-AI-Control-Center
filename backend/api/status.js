
import { Router } from 'express';
import { getStatus as getDshStatus } from '../services/dshService.js';
import { getLastSnapshot } from '../services/systemMonitor.js';
import { listTasks } from '../services/taskRunner.js';

const router = Router();

/** Combined dashboard status: DSH + system + task counters. */
router.get('/', async (req, res) => {
  const [dsh, system] = await Promise.all([getDshStatus(), Promise.resolve(getLastSnapshot())]);
  const activeTasks = listTasks({ status: ['queued', 'running', 'paused'], limit: 1 });
  const tasks = {
    running: listTasks({ status: 'running', limit: 500 }).length,
    queued: listTasks({ status: 'queued', limit: 500 }).length,
    paused: listTasks({ status: 'paused', limit: 500 }).length,
    active: activeTasks
  };
  res.json({ ts: new Date().toISOString(), dsh, system, tasks });
});

export default router;
