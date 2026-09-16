const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prompts = require('./prompts.cjs');

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
const asyncJobs = new Map();

function verifyAuth(req, res) {
  if (!SECRET_TOKEN) {
    console.warn('WARNING: API_SECRET is not configured on server.');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server misconfiguration: API_SECRET not set' }));
    return false;
  }

  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = `Bearer ${SECRET_TOKEN}`;

  const authBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expectedAuth);
  if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function processQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const item = queue.shift();
    if (item.isAborted) {
      continue;
    }

    activeJobs++;
    if (item.type === 'async_pipeline') {
      runAsyncPipeline(item.asyncJob, item.data).finally(() => {
        activeJobs--;
        processQueue();
      });
    } else {
      runJob(item).finally(() => {
        activeJobs--;
        processQueue();
      });
    }
  }
}

// Executes an agy command inside a sandboxed environment and returns the stdout text
function executeAgyCli(systemPrompt, userPrompt, model, effort) {
  return new Promise((resolve, reject) => {
    let combinedPrompt = '';
    if (systemPrompt) {
      combinedPrompt += `System Instructions:\n${systemPrompt}\n\n`;
    }
    combinedPrompt += `User Input:\n${userPrompt}`;

    let tempDir = null;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sandbox-'));
    } catch (dirErr) {
      return reject(new Error('Failed to create sandbox directory: ' + dirErr.message));
    }

    let secureHome = null;
    let homePath = null;
    try {
      homePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
      const secureConfigDir = path.join(homePath, '.gemini', 'antigravity-cli');
      fs.mkdirSync(secureConfigDir, { recursive: true });

      const realConfigDir = '/var/lib/agy-bridge/.gemini/antigravity-cli';
      
      try {
        fs.symlinkSync(path.join(realConfigDir, 'antigravity-oauth-token'), path.join(secureConfigDir, 'antigravity-oauth-token'));
      } catch (err) {
        fs.copyFileSync(path.join(realConfigDir, 'antigravity-oauth-token'), path.join(secureConfigDir, 'antigravity-oauth-token'));
      }

      try {
        fs.symlinkSync(path.join(realConfigDir, 'installation_id'), path.join(secureConfigDir, 'installation_id'));
      } catch (err) {
        fs.copyFileSync(path.join(realConfigDir, 'installation_id'), path.join(secureConfigDir, 'installation_id'));
      }

      fs.writeFileSync(path.join(secureConfigDir, 'settings.json'), JSON.stringify({ allowNonWorkspaceAccess: false }));
      secureHome = homePath;
    } catch (homeErr) {
      if (homePath) try { fs.rmSync(homePath, { recursive: true, force: true }); } catch (e) {}
      if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
      return reject(new Error('Failed to create secure home: ' + homeErr.message));
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
        tempDir = null;
      }
      if (secureHome) {
        try { fs.rmSync(secureHome, { recursive: true, force: true }); } catch (e) {}
        secureHome = null;
      }
    };

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

    let agy;
    try {
      agy = spawn(AGY_PATH, agyArgs, spawnOptions);
    } catch (spawnErr) {
      cleanup();
      return reject(spawnErr);
    }

    let output = '';
    const timer = setTimeout(() => {
      if (agy && !agy.killed) {
        agy.kill('SIGKILL');
      }
      cleanup();
      reject(new Error(`Command timed out after ${JOB_TIMEOUT_MS}ms`));
    }, JOB_TIMEOUT_MS);

    agy.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    agy.stderr.on('data', (chunk) => {
      console.error(`agy stderr: ${chunk}`);
    });

    agy.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      resolve(output);
    });

    agy.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

// Background multi-agent execution pipeline on the persistent VM
async function runAsyncPipeline(job, data) {
  job.status = 'processing';
  job.updatedAt = Date.now();
  const { resumeMarkdown, jobDescription, targetPageCount } = data;
  const pageLabel = targetPageCount === 1 ? "SINGLE PAGE" : `${targetPageCount} PAGES`;
  const totalAgents = jobDescription ? 5 : 4;
  let completedAgents = 0;

  console.log(`[Job ${job.id}] Starting multi-agent optimization pipeline (${totalAgents} subagents)...`);

  try {
    // 1. ATS Alignment Agent
    let atsFeedback = "";
    if (jobDescription) {
      job.stage = 'ats';
      job.percent = 20;
      job.message = 'Running ATS & Keyword Matcher agent...';
      job.updatedAt = Date.now();
      console.log(`[Job ${job.id}] Running ATS agent...`);

      atsFeedback = await executeAgyCli(
        prompts.getAtsSystemPrompt(),
        prompts.getAtsUserPrompt(resumeMarkdown, jobDescription)
      );

      completedAgents++;
      job.completedAgents = completedAgents;
      job.stage = 'ats_done';
      job.percent = 35;
      job.message = `ATS & Keyword Matcher finished (${completedAgents}/${totalAgents} subagents complete).`;
      job.updatedAt = Date.now();
    }

    // 2. Grammar, Tone & Impact Coach
    job.stage = 'grammar';
    job.percent = 40;
    job.message = 'Running Grammar, Tone & Impact Coach agent...';
    job.updatedAt = Date.now();
    console.log(`[Job ${job.id}] Running Grammar agent...`);

    const grammarFeedback = await executeAgyCli(
      prompts.getGrammarSystemPrompt(),
      prompts.getGrammarUserPrompt(resumeMarkdown)
    );

    completedAgents++;
    job.completedAgents = completedAgents;
    job.stage = 'grammar_done';
    job.percent = 55;
    job.message = `Grammar, Tone & Impact Coach finished (${completedAgents}/${totalAgents} subagents complete).`;
    job.updatedAt = Date.now();

    // 3. Layout & Spacing Auditor
    job.stage = 'layout';
    job.percent = 60;
    job.message = 'Running Layout & Spacing Auditor agent...';
    job.updatedAt = Date.now();
    console.log(`[Job ${job.id}] Running Layout agent...`);

    const layoutFeedback = await executeAgyCli(
      prompts.getLayoutSystemPrompt(pageLabel),
      prompts.getLayoutUserPrompt(resumeMarkdown)
    );

    completedAgents++;
    job.completedAgents = completedAgents;
    job.stage = 'layout_done';
    job.percent = 70;
    job.message = `Layout & Spacing Auditor finished (${completedAgents}/${totalAgents} subagents complete).`;
    job.updatedAt = Date.now();

    // Combine critiques
    let compositeCritiques = `### Grammar, Tone, and Impact Feedback\n${grammarFeedback}\n\n### Formatting and Layout Feedback\n${layoutFeedback}`;
    if (atsFeedback) {
      compositeCritiques = `### ATS Alignment and Keyword Feedback\n${atsFeedback}\n\n` + compositeCritiques;
    }

    // 4. Self-Correction Loop (Editor-in-Chief & Validator Agents)
    let validationFeedback = "";
    let attempts = 0;
    const maxAttempts = 3;
    let finalHtml = "";
    let finalCritique = "";

    while (attempts < maxAttempts) {
      attempts++;
      job.stage = 'editor';
      job.percent = Math.min(85, 75 + (attempts - 1) * 5);
      job.message = attempts === 1
        ? 'Editor-in-Chief: Synthesizing critiques and drafting rewritten résumé...'
        : `Editor-in-Chief: Refining draft based on validation audit (Pass ${attempts})...`;
      job.updatedAt = Date.now();
      console.log(`[Job ${job.id}] Running Editor-in-Chief (Attempt ${attempts})...`);

      const editorOutput = await executeAgyCli(
        prompts.getEditorSystemPrompt(pageLabel),
        prompts.getEditorUserPrompt(resumeMarkdown, jobDescription, compositeCritiques, validationFeedback)
      );

      const parts = editorOutput.split("=== REWRITTEN RESUME ===");
      finalCritique = parts[0]?.trim() || "";
      finalHtml = parts[1]?.trim() || "";

      if (attempts === 1) {
        completedAgents++;
        job.completedAgents = completedAgents;
        job.stage = 'editor_done';
        job.percent = 85;
        job.message = `Editor-in-Chief finished initial draft (${completedAgents}/${totalAgents} subagents complete).`;
        job.updatedAt = Date.now();
      }

      if (!finalHtml) {
        validationFeedback = "Validation Error: Could not find '=== REWRITTEN RESUME ===' delimiter or the HTML block is empty.";
        continue;
      }

      job.stage = 'validator';
      job.percent = 90;
      job.message = `Compliance Auditor: Auditing HTML draft against ATS & layout rules (Pass ${attempts})...`;
      job.updatedAt = Date.now();
      console.log(`[Job ${job.id}] Auditing HTML compliance (Attempt ${attempts})...`);

      const auditResult = (await executeAgyCli(
        prompts.getValidatorSystemPrompt(pageLabel),
        prompts.getValidatorUserPrompt(finalHtml)
      )).trim();

      if (auditResult.toUpperCase() === "PASS") {
        console.log(`[Job ${job.id}] Compliance audit passed.`);
        completedAgents++;
        job.completedAgents = completedAgents;
        job.stage = 'validator_done';
        job.percent = 100;
        job.message = `Compliance audit passed! (${completedAgents}/${totalAgents} subagents complete).`;
        job.updatedAt = Date.now();
        break;
      } else {
        console.warn(`[Job ${job.id}] Audit failed on attempt ${attempts}: ${auditResult.substring(0, 100)}...`);
        validationFeedback = auditResult;
      }
    }

    const critique = finalCritique + "\n\n=== REWRITTEN RESUME ===\n" + finalHtml;
    job.status = 'complete';
    job.percent = 100;
    job.message = 'Optimization complete!';
    job.result = {
      critique,
      extractedTextLength: resumeMarkdown.length,
      targetPageCount
    };
    job.updatedAt = Date.now();
    console.log(`[Job ${job.id}] Multi-agent pipeline completed successfully!`);

  } catch (pipelineErr) {
    console.error(`[Job ${job.id}] Multi-agent pipeline failed:`, pipelineErr);
    job.status = 'error';
    job.error = pipelineErr.message || String(pipelineErr);
    job.message = `Optimization failed: ${job.error}`;
    job.updatedAt = Date.now();
  }
}

// Synchronous single execution runner for backward compatibility
function runJob(job) {
  return new Promise((resolve) => {
    const { req, res, systemPrompt, userPrompt, model, effort } = job;

    if (job.isAborted) {
      resolve();
      return;
    }

    let combinedPrompt = '';
    if (systemPrompt) {
      combinedPrompt += `System Instructions:\n${systemPrompt}\n\n`;
    }
    combinedPrompt += `User Input:\n${userPrompt}`;

    let tempDir = null;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sandbox-'));
    } catch (dirErr) {
      console.error('Failed to create temporary directory for sandbox:', dirErr);
    }

    let secureHome = null;
    let homePath = null;
    try {
      homePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
      const secureConfigDir = path.join(homePath, '.gemini', 'antigravity-cli');
      fs.mkdirSync(secureConfigDir, { recursive: true });

      const realConfigDir = '/var/lib/agy-bridge/.gemini/antigravity-cli';
      
      try {
        fs.symlinkSync(path.join(realConfigDir, 'antigravity-oauth-token'), path.join(secureConfigDir, 'antigravity-oauth-token'));
      } catch (err) {
        fs.copyFileSync(path.join(realConfigDir, 'antigravity-oauth-token'), path.join(secureConfigDir, 'antigravity-oauth-token'));
      }

      try {
        fs.symlinkSync(path.join(realConfigDir, 'installation_id'), path.join(secureConfigDir, 'installation_id'));
      } catch (err) {
        fs.copyFileSync(path.join(realConfigDir, 'installation_id'), path.join(secureConfigDir, 'installation_id'));
      }

      fs.writeFileSync(path.join(secureConfigDir, 'settings.json'), JSON.stringify({ allowNonWorkspaceAccess: false }));
      secureHome = homePath;
    } catch (homeErr) {
      console.error('Failed to initialize secure HOME profile:', homeErr);
      if (homePath) {
        try { fs.rmSync(homePath, { recursive: true, force: true }); } catch (e) {}
      }
      secureHome = null;
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
        tempDir = null;
      }
      if (secureHome) {
        try { fs.rmSync(secureHome, { recursive: true, force: true }); } catch (e) {}
        secureHome = null;
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
        try { res.end(); } catch (e) {}
      }

      resolve();
    };

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
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      if (res.flushHeaders) {
        res.flushHeaders();
      }

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

  // 1. Asynchronous Job Submission Endpoint
  if (req.method === 'POST' && req.url === '/job/submit') {
    if (!verifyAuth(req, res)) return;

    let body = '';
    let bodySize = 0;
    let exceeded = false;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        exceeded = true;
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
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
        if (!data.resumeMarkdown) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing resumeMarkdown' }));
          return;
        }

        const jobId = data.jobId || crypto.randomUUID();
        const asyncJob = {
          id: jobId,
          status: 'queued',
          stage: 'queued',
          completedAgents: 0,
          totalAgents: data.jobDescription ? 5 : 4,
          percent: 5,
          message: 'Job enqueued for agent evaluation...',
          result: null,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        asyncJobs.set(jobId, asyncJob);
        // Expire jobs after 1 hour
        setTimeout(() => asyncJobs.delete(jobId), 3600000).unref();

        queue.push({
          type: 'async_pipeline',
          jobId,
          data,
          asyncJob
        });

        console.log(`[Queue] Async job ${jobId} enqueued. (Queue length: ${queue.length}, active: ${activeJobs}/${MAX_CONCURRENT_JOBS})`);
        processQueue();

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'queued',
          jobId,
          totalAgents: asyncJob.totalAgents,
          message: 'Job accepted and queued'
        }));

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // 2. Asynchronous Job Status Endpoint
  if (req.method === 'GET' && req.url.startsWith('/job/')) {
    if (!verifyAuth(req, res)) return;

    const jobId = req.url.slice('/job/'.length);
    const job = asyncJobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: job.id,
      status: job.status,
      stage: job.stage,
      completedAgents: job.completedAgents,
      totalAgents: job.totalAgents,
      percent: job.percent,
      message: job.message,
      result: job.result,
      error: job.error,
      updatedAt: job.updatedAt
    }));
    return;
  }

  // 3. Synchronous Execution Endpoint (Streaming)
  if (req.method === 'POST' && req.url === '/execute') {
    if (!verifyAuth(req, res)) return;

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
          type: 'sync',
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
    return;
  }

  // 4. Health & Monitoring Endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeJobs,
      queueLength: queue.length,
      asyncJobsCount: asyncJobs.size
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
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
