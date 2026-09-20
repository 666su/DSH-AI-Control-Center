
import { Router } from 'express';
import statusRouter from './status.js';
import systemRouter from './system.js';
import dshRouter from './dsh.js';
import tasksRouter from './tasks.js';
import logsRouter from './logs.js';
import notifyRouter from './notify.js';
import monitorRouter from './monitor.js';
import healthRouter from './health.js';

const router = Router();
router.use('/status', statusRouter);
router.use('/system', systemRouter);
router.use('/dsh', dshRouter);
router.use('/tasks', tasksRouter);
router.use('/logs', logsRouter);
router.use('/notify', notifyRouter);
router.use('/monitor', monitorRouter);
router.use('/health', healthRouter);
export default router;
