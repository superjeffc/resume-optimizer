const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8000;
const HOST = '127.0.0.1';
const SECRET_TOKEN = process.env.API_SECRET || '';
const AGY_PATH = process.env.AGY_PATH || '/var/lib/agy-bridge/bin/agy';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '50', 10);
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '300000', 10);

const queue = [];
let activeCount = 0;
let jobCounter = 0;

function processQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.cancelled || job.req.destroyed || job.res.writableEnded) {
      continue;
    }
    executeJob(job);
  }
}

function executeJob(job) {
  job.started = true;
  activeCount++;
  const startTime = Date.now();
  const waitTime = startTime - job.enqueuedAt;
  console.log(`[Queue] Starting Job #${job.id} (waited ${waitTime}ms). Active: ${activeCount}/${MAX_CONCURRENT}, Queue remaining: ${queue.length}`);

  let tempDir = null;
  let secureHome = null;
  let finished = false;
  job.finished = false;

  const finishJob = () => {
    if (finished) return;
    finished = true;
    job.finished = true;

    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
      job.timeoutTimer = null;
    }

    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`[Job #${job.id}] Cleaned up sandbox directory: ${tempDir}`);
      } catch (rmErr) {
        console.error(`[Job #${job.id}] Failed to clean up sandbox directory ${tempDir}:`, rmErr);
      }
    }
    if (secureHome) {
      try {
        fs.rmSync(secureHome, { recursive: true, force: true });
        console.log(`[Job #${job.id}] Cleaned up secure home directory: ${secureHome}`);
      } catch (rmErr) {
        console.error(`[Job #${job.id}] Failed to clean up secure home directory ${secureHome}:`, rmErr);
      }
    }

    if (!job.res.writableEnded) {
      try {
        job.res.end();
      } catch (e) {}
    }

    activeCount--;
    const duration = Date.now() - startTime;
    console.log(`[Queue] Job #${job.id} completed in ${duration}ms. Active: ${activeCount}/${MAX_CONCURRENT}, Queue remaining: ${queue.length}`);
    process.nextTick(processQueue);
  };

  try {
    job.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked'
    });
  } catch (hdrErr) {
    console.error(`[Job #${job.id}] Error writing response headers:`, hdrErr);
    finishJob();
    return;
  }

  // Create temporary directory for sandbox
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sandbox-'));
  } catch (dirErr) {
    console.error(`[Job #${job.id}] Failed to create temporary directory for sandbox:`, dirErr);
  }

  // Create temporary secure HOME profile
  try {
    secureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
    const secureConfigDir = path.join(secureHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(secureConfigDir, { recursive: true });

    const realConfigDir = '/var/lib/agy-bridge/.gemini/antigravity-cli';
    
    try {
      fs.symlinkSync(
        path.join(realConfigDir, 'antigravity-oauth-token'),
        path.join(secureConfigDir, 'antigravity-oauth-token')
      );
    } catch (err) {
      fs.copyFileSync(
        path.join(realConfigDir, 'antigravity-oauth-token'),
        path.join(secureConfigDir, 'antigravity-oauth-token')
      );
    }

    try {
      fs.symlinkSync(
        path.join(realConfigDir, 'installation_id'),
        path.join(secureConfigDir, 'installation_id')
      );
    } catch (err) {
      fs.copyFileSync(
        path.join(realConfigDir, 'installation_id'),
        path.join(secureConfigDir, 'installation_id')
      );
    }

    fs.writeFileSync(
      path.join(secureConfigDir, 'settings.json'),
      JSON.stringify({ allowNonWorkspaceAccess: false })
    );
  } catch (homeErr) {
    console.error(`[Job #${job.id}] Failed to initialize secure HOME profile:`, homeErr);
  }

  if (!tempDir || !secureHome) {
    console.error(`[Job #${job.id}] Failed to initialize secure execution environment (tempDir or secureHome missing).`);
    if (!job.res.writableEnded) {
      job.res.write('[Error: Failed to initialize secure execution environment]');
    }
    finishJob();
    return;
  }

  // Construct combined prompt
  let combinedPrompt = '';
  if (job.systemPrompt) {
    combinedPrompt += `System Instructions:\n${job.systemPrompt}\n\n`;
  }
  combinedPrompt += `User Input:\n${job.userPrompt}`;

  // Execution timeout handler
  job.timeoutTimer = setTimeout(() => {
    console.error(`[Job #${job.id}] Timed out after ${JOB_TIMEOUT_MS}ms`);
    if (job.agyProcess && !finished) {
      try {
        job.agyProcess.kill('SIGKILL');
      } catch (e) {}
    }
    if (!job.res.writableEnded) {
      job.res.write('\n[Error: Job execution timed out]');
    }
    finishJob();
  }, JOB_TIMEOUT_MS);

  try {
    console.log(`[Job #${job.id}] Executing AGY command...`);
    const agyArgs = ['--sandbox', '--print', combinedPrompt];
    const spawnOptions = {
      cwd: tempDir,
      env: {
        ...process.env,
        HOME: secureHome
      }
    };
    const agy = spawn(AGY_PATH, agyArgs, spawnOptions);
    job.agyProcess = agy;

    agy.stdout.on('data', (chunk) => {
      if (!finished && !job.res.writableEnded) {
        job.res.write(chunk);
      }
    });

    agy.stderr.on('data', (chunk) => {
      console.error(`[Job #${job.id}] agy stderr: ${chunk}`);
    });

    agy.on('close', (code) => {
      console.log(`[Job #${job.id}] agy process completed with code ${code}`);
      finishJob();
    });

    agy.on('error', (err) => {
      console.error(`[Job #${job.id}] Failed to start agy process:`, err);
      if (!finished && !job.res.writableEnded) {
        job.res.write(`\n[Error: Failed to execute agy CLI: ${err.message}]`);
      }
      finishJob();
    });
  } catch (spawnErr) {
    console.error(`[Job #${job.id}] Synchronous error spawning agy process:`, spawnErr);
    if (!finished && !job.res.writableEnded) {
      job.res.write(`\n[Error: Failed to spawn agy CLI: ${spawnErr.message}]`);
    }
    finishJob();
  }
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health and queue status monitoring endpoint
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/health' || req.url === '/queue')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeCount,
      queueLength: queue.length,
      maxConcurrent: MAX_CONCURRENT,
      maxQueueSize: MAX_QUEUE_SIZE
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { systemPrompt, userPrompt } = data;
        
        if (!userPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing userPrompt' }));
          return;
        }

        if (queue.length >= MAX_QUEUE_SIZE) {
          console.warn(`[Queue] Rejecting request: queue full (${queue.length}/${MAX_QUEUE_SIZE})`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Bridge service is at capacity. Please try again shortly.',
            activeCount,
            queueLength: queue.length
          }));
          return;
        }

        jobCounter++;
        const job = {
          id: jobCounter,
          systemPrompt,
          userPrompt,
          req,
          res,
          enqueuedAt: Date.now(),
          cancelled: false,
          started: false,
          finished: false,
          timeoutTimer: null,
          agyProcess: null
        };

        const onClientClose = () => {
          if (!job.started) {
            job.cancelled = true;
            const idx = queue.indexOf(job);
            if (idx !== -1) {
              queue.splice(idx, 1);
              console.log(`[Queue] Job #${job.id} cancelled while waiting in queue. Queue length: ${queue.length}`);
            }
          } else if (job.agyProcess && !job.finished) {
            console.log(`[Queue] Killing running Job #${job.id} due to client disconnect.`);
            try {
              job.agyProcess.kill('SIGTERM');
            } catch (e) {}
          }
        };

        req.on('close', onClientClose);

        queue.push(job);
        console.log(`[Queue] Job #${job.id} enqueued. Position: ${queue.length}, Active: ${activeCount}/${MAX_CONCURRENT}`);

        processQueue();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bridge server listening on http://${HOST}:${PORT} (MAX_CONCURRENT=${MAX_CONCURRENT}, MAX_QUEUE_SIZE=${MAX_QUEUE_SIZE})`);
});

