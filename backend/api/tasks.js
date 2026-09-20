
import { Router } from 'express';
import { getAvailableModels } from '../services/modelList.js';
import { listTasks, getTask, createTask, controlTask, readTaskLog } from '../services/taskRunner.js';

const router = Router();

router.get('/models', (req, res) => {
  res.json(getAvailableModels());
});

router.get('/', (req, res) => {
  const { status, limit } = req.query;
  res.json(listTasks({ status, limit }));
});

router.post('/', async (req, res) => {
  const { name, instruction, workspace } = req.body || {};
  const result = await createTask({ name, instruction, workspace });
  res.status(result.ok ? 201 : 400).json(result);
});

router.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });
  res.json(task);
});

router.get('/:id/log', (req, res) => {
  const maxLen = Math.min(Number(req.query.maxLen) || 20000, 200000);
  const { text, truncated } = readTaskLog(req.params.id, maxLen);
  res.json({ id: req.params.id, truncated, text });
});

router.post('/:id/control', async (req, res) => {
  const { action } = req.body || {};
  if (!['pause', 'resume', 'cancel'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'action must be pause, resume or cancel' });
  }
  const result = await controlTask(req.params.id, action);
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
