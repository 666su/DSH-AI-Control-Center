import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, LOG_DIR } from '../config.js';
import { readMonitorState } from '../services/dshService.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECOVERY_LOG = path.join(__dirname, '..', '..', 'logs', 'recovery.log');
const NOTIFY_LOG = path.join(__dirname, '..', '..', 'logs', 'notify.log');

/** Tail the last N lines of a log file. */
function tail(file, n = 40) {
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    return lines.slice(-n);
  } catch { return []; }
}

/** Recovery daemon live status: state snapshot + recent recovery events. */
router.get('/status', async (req, res) => {
  const state = readMonitorState();
  const logPath = path.join(LOG_DIR, 'recovery.log');
  const recent = tail(logPath, 40);
  res.json({
    state,
    configured: {
      intervalMs: config.recovery.intervalMs,
      autoRestart: config.recovery.autoRestart,
      failThreshold: config.recovery.failThreshold,
      maxAttempts: config.recovery.maxAttempts,
      cooldownsMs: config.recovery.cooldownsMs
    },
    recent
  });
});

export default router;
