const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8000;
const HOST = '127.0.0.1';
const SECRET_TOKEN = process.env.API_SECRET || '';
const AGY_PATH = process.env.AGY_PATH || '/var/lib/agy-bridge/bin/agy';
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10); // Limit concurrency to 1 to prevent swap thrashing on 1GB RAM VM
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '10', 10);         // Max pending jobs before returning 429
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '300000', 10);     // 5 minute timeout to prevent unkillable hanging processes
const MAX_BODY_SIZE = 5 * 1024 * 1024;                                           // 5 MB max payload size to prevent memory exhaustion

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high']);
const MODEL_REGEX = /^[a-zA-Z0-9_.:-]+$/;

let activeJobs = 0;
const queue = [];

function processQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift();
    if (job.isAborted) {
      continue;
    }

    activeJobs++;
    runJob(job).finally(() => {
      activeJobs--;
      processQueue();
    });
  }
}

function runJob(job) {
  return new Promise((resolve) => {
    const { req, res, systemPrompt, userPrompt, model, effort } = job;

    if (job.isAborted) {
      resolve();
      return;
    }

    // Construct combined prompt
    let combinedPrompt = '';
    if (systemPrompt) {
      combinedPrompt += `System Instructions:\n${systemPrompt}\n\n`;
    }
    combinedPrompt += `User Input:\n${userPrompt}`;

    // Create temporary directory for sandbox
    let tempDir = null;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sandbox-'));
    } catch (dirErr) {
      console.error('Failed to create temporary directory for sandbox:', dirErr);
    }

    // Create temporary secure HOME profile to prevent non-workspace file access
    let secureHome = null;
    let homePath = null;
    try {
      homePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
      const secureConfigDir = path.join(homePath, '.gemini', 'antigravity-cli');
      fs.mkdirSync(secureConfigDir, { recursive: true });

      const realConfigDir = '/var/lib/agy-bridge/.gemini/antigravity-cli';
      
      // Copy or symlink credentials and installation ID
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

      // Write settings.json forcing allowNonWorkspaceAccess to false
      fs.writeFileSync(
        path.join(secureConfigDir, 'settings.json'),
        JSON.stringify({ allowNonWorkspaceAccess: false })
      );

      // Only assign after full initialization succeeds atomically
      secureHome = homePath;
    } catch (homeErr) {
      console.error('Failed to initialize secure HOME profile:', homeErr);
      if (homePath) {
        try {
          fs.rmSync(homePath, { recursive: true, force: true });
        } catch (e) {}
      }
      secureHome = null;
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          console.log(`Cleaned up sandbox directory: ${tempDir}`);
          tempDir = null;
        } catch (rmErr) {
          console.error(`Failed to clean up sandbox directory ${tempDir}:`, rmErr);
        }
      }
      if (secureHome) {
        try {
          fs.rmSync(secureHome, { recursive: true, force: true });
          console.log(`Cleaned up secure home directory: ${secureHome}`);
          secureHome = null;
        } catch (rmErr) {
          console.error(`Failed to clean up secure home directory ${secureHome}:`, rmErr);
        }
      }
    };

    let isResolved = false;
    let timeoutTimer = null;

    const done = () => {
      if (isResolved) return;
      isResolved = true;
      job.isCompleted = true;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }

      cleanup();

      if (!res.writableEnded) {
        try {
          res.end();
        } catch (e) {}
      }

      resolve();
    };

    // Fail closed: reject request if the secure sandboxed environment could not be fully initialized
    if (!tempDir || !secureHome) {
      console.error('Failed to initialize secure execution environment (tempDir or secureHome is missing).');
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to initialize secure execution environment' }));
      }
      done();
      return;
    }

    let agy = null;

    // Abort handler: ensures process is terminated and fully closed before freeing resources
    job.onAbort = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }

      const isAgyRunning = agy && !agy.killed && agy.exitCode === null && agy.signalCode === null;
      if (isAgyRunning) {
        console.log('Client aborted connection. Terminating agy process...');
        const killTimer = setTimeout(() => {
          if (agy && !agy.killed) {
            agy.kill('SIGKILL');
          }
        }, 3000);

        agy.once('close', () => {
          clearTimeout(killTimer);
          done();
        });

        try {
          agy.kill('SIGTERM');
        } catch (e) {}
      } else {
        done();
      }
    };

    if (job.isAborted) {
      job.onAbort();
      return;
    }

    try {
      // Flush response headers immediately to inform Cloudflare / proxy of active connection
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      if (res.flushHeaders) {
        res.flushHeaders();
      }

      // Spawn agy process with sandbox and security flags
      console.log(`[Queue: ${queue.length} pending, active: ${activeJobs}] Executing AGY command for request...`);
      const agyArgs = ['--sandbox', '--disable-slash-commands', '--print', combinedPrompt];
      if (model && typeof model === 'string' && MODEL_REGEX.test(model) && !model.startsWith('-')) {
        agyArgs.push('--model', model);
      }
      if (effort && typeof effort === 'string' && ALLOWED_EFFORTS.has(effort)) {
        agyArgs.push('--effort', effort);
      }

      const spawnOptions = {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: secureHome
        }
      };

      agy = spawn(AGY_PATH, agyArgs, spawnOptions);

      // Timeout watchdog to prevent deadlocks / infinite stalls
      timeoutTimer = setTimeout(() => {
        console.error(`Job execution timed out after ${JOB_TIMEOUT_MS}ms. Killing process...`);
        if (!res.writableEnded) {
          res.write('\n[Error: Job execution timed out]');
        }
        if (agy && !agy.killed) {
          agy.kill('SIGKILL');
        }
        setTimeout(done, 1000);
      }, JOB_TIMEOUT_MS);

      agy.stdout.on('data', (chunk) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      agy.stderr.on('data', (chunk) => {
        console.error(`agy stderr: ${chunk}`);
      });

      agy.on('close', (code) => {
        console.log(`agy process completed with code ${code}`);
        done();
      });

      agy.on('error', (err) => {
        console.error('Failed to start agy process:', err);
        if (!res.writableEnded) {
          res.write(`\n[Error: Failed to execute agy CLI: ${err.message}]`);
        }
        done();
      });
    } catch (spawnErr) {
      console.error('Synchronous error spawning agy process:', spawnErr);
      if (!res.writableEnded) {
        res.write(`\n[Error: Failed to spawn agy CLI: ${spawnErr.message}]`);
      }
      done();
    }
  });
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    if (!SECRET_TOKEN) {
      console.warn('WARNING: API_SECRET is not configured on server.');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server misconfiguration: API_SECRET not set' }));
      return;
    }

    const authHeader = req.headers['authorization'] || '';
    const expectedAuth = `Bearer ${SECRET_TOKEN}`;

    const authBuf = Buffer.from(authHeader);
    const expectedBuf = Buffer.from(expectedAuth);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    let bodySize = 0;
    let exceeded = false;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        exceeded = true;
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large (Max 5MB)' }));
        }
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (exceeded) return;

      try {
        const data = JSON.parse(body);
        const { systemPrompt, userPrompt, model, effort } = data;
        
        if (!userPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing userPrompt' }));
          return;
        }

        if (queue.length >= MAX_QUEUE_SIZE) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too Many Requests: Server queue is full' }));
          return;
        }

        const job = {
          req,
          res,
          systemPrompt,
          userPrompt,
          model,
          effort,
          isCompleted: false,
          isAborted: false,
          onAbort: null
        };

        res.on('close', () => {
          if (!job.isCompleted) {
            job.isAborted = true;
            const idx = queue.indexOf(job);
            if (idx !== -1) {
              queue.splice(idx, 1);
              console.log(`[Queue] Job removed from queue on client disconnect. Queue remaining: ${queue.length}`);
            }
            if (job.onAbort) {
              job.onAbort();
            }
          }
        });

        queue.push(job);
        processQueue();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeJobs,
      queueLength: queue.length
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

const gracefulShutdown = () => {
  console.log('Received termination signal. Closing bridge server...');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.listen(PORT, HOST, () => {
  console.log(`Bridge server listening on http://${HOST}:${PORT} (Concurrency limit: ${MAX_CONCURRENT_JOBS})`);
});
