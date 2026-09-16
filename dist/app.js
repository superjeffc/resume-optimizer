// Compute API URL dynamically based on environment
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:8787/' 
  : '/api/';

// DOM Elements
const uploadCard = document.getElementById('upload-card');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const fileName = document.getElementById('file-name');
const fileSize = document.getElementById('file-size');
const removeFileBtn = document.getElementById('remove-file-btn');
const analyzeBtn = document.getElementById('analyze-btn');

const loadingCard = document.getElementById('loading-card');
const loadingStep = document.getElementById('loading-step');

const resultsCard = document.getElementById('results-card');
const critiqueContent = document.getElementById('critique-content');
const extractedMeta = document.getElementById('extracted-meta');
const downloadHtmlTopBtn = document.getElementById('download-html-top-btn');
const newCritiqueBtn = document.getElementById('new-critique-btn');


// Turnstile widget DOM elements
const turnstileContainer = document.getElementById('turnstile-container');

// Tabs and Resume Preview DOM elements
const tabCritiqueBtn = document.getElementById('tab-critique-btn');
const tabResumeBtn = document.getElementById('tab-resume-btn');
const critiquePanel = document.getElementById('critique-panel');
const resumePanel = document.getElementById('resume-panel');
const resumePreviewContent = document.getElementById('resume-preview-content');
const downloadPdfBtn = document.getElementById('download-pdf-btn');
const downloadPdfTopBtn = document.getElementById('download-pdf-top-btn');
const downloadHtmlBtn = document.getElementById('download-html-btn');
const jobDescInput = document.getElementById('job-desc-input');
const charCount = document.getElementById('char-count');
const charLimitWarning = document.getElementById('char-limit-warning');

let selectedFile = null;
let currentCritiqueMarkdown = "";
let currentResumeHtml = "";
let targetPageCount = 1;

// Real-time subagent progress tracking DOM elements
const loadingSubagentsCount = document.getElementById('loading-subagents-count');
const loadingSubagentsTotal = document.getElementById('loading-subagents-total');
const loadingPercent = document.getElementById('loading-percent');
const loadingProgressBar = document.getElementById('loading-progress-bar');
const loadingAgentList = document.getElementById('loading-agent-list');

const PIPELINE_STAGES = [
  { id: 'extraction', label: 'Document Ingestion & Text Extraction' },
  { id: 'ats', label: 'ATS & Keyword Matcher Agent', requiresJobDesc: true },
  { id: 'grammar', label: 'Grammar, Tone & Impact Coach' },
  { id: 'layout', label: 'Layout & Spacing Auditor' },
  { id: 'editor', label: 'Editor-in-Chief Synthesis Agent' },
  { id: 'validator', label: 'Compliance Auditor & Validator' }
];

function initLoadingUI(hasJobDesc) {
  const activeStages = PIPELINE_STAGES.filter(s => !s.requiresJobDesc || hasJobDesc);
  const totalSubagents = hasJobDesc ? 5 : 4;

  if (loadingSubagentsCount) loadingSubagentsCount.textContent = "0";
  if (loadingSubagentsTotal) loadingSubagentsTotal.textContent = String(totalSubagents);
  if (loadingPercent) loadingPercent.textContent = "5%";
  if (loadingProgressBar) loadingProgressBar.style.width = "5%";
  if (loadingStep) loadingStep.textContent = "Extracting text and document structure...";

  if (loadingAgentList) {
    loadingAgentList.innerHTML = activeStages.map(stage => `
      <div id="step-${stage.id}" class="flex items-center justify-between py-1.5 px-2.5 rounded-lg text-gray-500 transition-all duration-200">
        <div class="flex items-center gap-2.5">
          <span class="step-indicator w-4 h-4 rounded-full flex items-center justify-center text-[10px] bg-slate-800 border border-slate-700 text-gray-500 font-mono">○</span>
          <span class="step-label font-medium">${stage.label}</span>
        </div>
        <span class="step-status text-[11px] text-gray-600 font-mono">Waiting</span>
      </div>
    `).join('');
  }
}

function setStageState(stageId, state) {
  const stepEl = document.getElementById(`step-${stageId}`);
  if (!stepEl) return;

  const indicator = stepEl.querySelector('.step-indicator');
  const statusText = stepEl.querySelector('.step-status');

  if (state === 'done') {
    stepEl.className = 'flex items-center justify-between py-1.5 px-2.5 rounded-lg text-emerald-400 bg-emerald-950/30 border border-emerald-900/50';
    if (indicator) {
      indicator.className = 'step-indicator w-4 h-4 rounded-full flex items-center justify-center text-[10px] bg-emerald-900 border border-emerald-500 text-emerald-300 font-bold';
      indicator.textContent = '✓';
    }
    if (statusText) {
      statusText.className = 'step-status text-[11px] text-emerald-400 font-mono font-semibold';
      statusText.textContent = 'Done';
    }
  } else if (state === 'running') {
    stepEl.className = 'flex items-center justify-between py-1.5 px-2.5 rounded-lg text-indigo-300 bg-indigo-950/40 border border-indigo-900/60 shadow-sm';
    if (indicator) {
      indicator.className = 'step-indicator w-4 h-4 rounded-full flex items-center justify-center text-[10px] bg-indigo-900 border border-indigo-500 text-cyan-300 animate-pulse font-bold';
      indicator.textContent = '●';
    }
    if (statusText) {
      statusText.className = 'step-status text-[11px] text-cyan-300 font-mono animate-pulse';
      statusText.textContent = 'Running...';
    }
  } else {
    stepEl.className = 'flex items-center justify-between py-1.5 px-2.5 rounded-lg text-gray-500 transition-all duration-200';
    if (indicator) {
      indicator.className = 'step-indicator w-4 h-4 rounded-full flex items-center justify-center text-[10px] bg-slate-800 border border-slate-700 text-gray-500 font-mono';
      indicator.textContent = '○';
    }
    if (statusText) {
      statusText.className = 'step-status text-[11px] text-gray-600 font-mono';
      statusText.textContent = 'Waiting';
    }
  }
}

function updateProgressUI(event) {
  if (loadingStep && event.message) {
    loadingStep.textContent = event.message;
  }
  if (loadingSubagentsCount && event.completedAgents !== undefined) {
    loadingSubagentsCount.textContent = String(event.completedAgents);
  }
  if (loadingSubagentsTotal && event.totalAgents !== undefined) {
    loadingSubagentsTotal.textContent = String(event.totalAgents);
  }
  if (loadingPercent && event.percent !== undefined) {
    loadingPercent.textContent = `${event.percent}%`;
  }
  if (loadingProgressBar && event.percent !== undefined) {
    loadingProgressBar.style.width = `${Math.max(5, Math.min(100, event.percent))}%`;
  }

  if (!loadingAgentList) return;

  if (event.status === 'complete' || event.percent === 100) {
    PIPELINE_STAGES.forEach(s => setStageState(s.id, 'done'));
    if (loadingSubagentsTotal && loadingSubagentsCount) {
      loadingSubagentsCount.textContent = loadingSubagentsTotal.textContent;
    }
    return;
  }

  if (event.stage) {
    const isDone = event.stage.endsWith('_done');
    const stageKey = event.stage.replace('_done', '');

    // Determine active stages currently in the DOM
    const domStages = PIPELINE_STAGES.filter(s => document.getElementById(`step-${s.id}`));
    const currentIndex = domStages.findIndex(s => s.id === stageKey);

    if (currentIndex !== -1) {
      domStages.forEach((stage, idx) => {
        if (idx < currentIndex) {
          // Preceding stages are completed
          setStageState(stage.id, 'done');
        } else if (idx === currentIndex) {
          // Current stage is running or done
          setStageState(stage.id, isDone ? 'done' : 'running');
        } else {
          // Following stages are still waiting
          setStageState(stage.id, 'waiting');
        }
      });
    }
  }
}

// Prevent default drag behaviors for the entire window to stop the browser from opening files
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  window.addEventListener(eventName, (e) => {
    e.preventDefault();
  }, false);
});

// Initialize Drag & Drop Events for the drop zone
['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add('border-indigo-500/70', 'bg-indigo-950/10');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500/70', 'bg-indigo-950/10');
  }, false);
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length > 0) {
    handleFileSelect(files[0]);
  }
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelect(e.target.files[0]);
  }
});

if (jobDescInput) {
  ['input', 'keyup', 'paste', 'change'].forEach(evt => {
    jobDescInput.addEventListener(evt, () => {
      // Small delay on paste to allow value to update
      if (evt === 'paste') {
        setTimeout(updateCharCount, 0);
      } else {
        updateCharCount();
      }
    });
  });
  // Initialize on load to handle autocomplete or history restores
  updateCharCount();
}

function updateCharCount() {
  if (!jobDescInput || !charCount) return;
  const len = jobDescInput.value.length;
  charCount.textContent = len.toLocaleString();
  
  if (len >= 9500) {
    charCount.className = "font-bold text-red-400 code-font";
    if (charLimitWarning) {
      charLimitWarning.textContent = "Approaching character limit";
      charLimitWarning.classList.remove('opacity-0');
      charLimitWarning.classList.add('opacity-100');
    }
  } else if (len >= 8000) {
    charCount.className = "font-bold text-yellow-400 code-font";
    if (charLimitWarning) {
      charLimitWarning.textContent = "Approaching character limit";
      charLimitWarning.classList.remove('opacity-0');
      charLimitWarning.classList.add('opacity-100');
    }
  } else {
    charCount.className = "font-bold text-gray-400 code-font";
    if (charLimitWarning) {
      charLimitWarning.classList.remove('opacity-100');
      charLimitWarning.classList.add('opacity-0');
    }
  }
}

// Remove file click handler
removeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearSelectedFile();
});

// Process Selected File
function handleFileSelect(file) {
  const fileType = file.type || '';
  const name = (file.name || '').toLowerCase();
  const isPdf = fileType === 'application/pdf' || name.endsWith('.pdf');
  const isImage = fileType.startsWith('image/') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg');
  
  if (!isPdf && !isImage) {
    alert("Invalid file format. Please upload a PDF or a PNG/JPEG image.");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    alert("File size exceeds 5MB. Please upload a smaller file.");
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  
  fileInfo.classList.remove('hidden');
  analyzeBtn.classList.remove('hidden');
  if (turnstileContainer) turnstileContainer.classList.remove('hidden');
}

function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  analyzeBtn.classList.add('hidden');
  if (turnstileContainer) turnstileContainer.classList.add('hidden');
  if (window.turnstile) window.turnstile.reset();
  if (jobDescInput) {
    jobDescInput.value = '';
    updateCharCount();
  }

  // Reset tab states
  if (tabCritiqueBtn && tabResumeBtn && critiquePanel && resumePanel) {
    critiquePanel.classList.remove('hidden');
    resumePanel.classList.add('hidden');
    tabCritiqueBtn.className = "text-xs bg-slate-900 border border-slate-800/80 text-indigo-400 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5 border-b-2 border-indigo-500";
    tabResumeBtn.className = "text-xs bg-slate-950/40 border border-slate-900/60 text-gray-400 hover:text-indigo-400 hover:bg-slate-900 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5";
  }
  if (resumePreviewContent) {
    resumePreviewContent.innerHTML = '';
  }
  currentCritiqueMarkdown = "";
  currentResumeHtml = "";
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Start analysis upload process
analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const jobDesc = jobDescInput ? jobDescInput.value.trim() : "";
  if (jobDesc.length > 10000) {
    alert("Job description is too long. The maximum limit is 10,000 characters.");
    return;
  }

  // 1. Retrieve Turnstile token
  const token = window.turnstile ? window.turnstile.getResponse() : "";
  if (!token) {
    alert("Please complete the Turnstile verification first.");
    return;
  }

  // 2. Validate token against the siteverify Worker
  try {
    const verifyResponse = await fetch("https://turnstile-siteverify-cs-resume-critique.superjeffc.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });

    if (!verifyResponse.ok) {
      throw new Error(`Verification service returned status ${verifyResponse.status}`);
    }

    const verifyData = await verifyResponse.json();
    if (!verifyData.success) {
      alert("Turnstile verification failed. Please try again.");
      if (window.turnstile) window.turnstile.reset();
      return;
    }
  } catch (err) {
    console.error("Turnstile verification error:", err);
    alert(`Verification failed: ${err.message || err}. Please try again.`);
    if (window.turnstile) window.turnstile.reset();
    return;
  }

  // Show Loading Screen
  uploadCard.classList.add('hidden');
  loadingCard.classList.remove('hidden');
  
  initLoadingUI(Boolean(jobDesc));

  const formData = new FormData();
  formData.append('resume', selectedFile);
  
  if (jobDesc) {
    formData.append('jobDescription', jobDesc);
  }

  try {
    updateProgressUI({
      stage: 'extraction',
      completedAgents: 0,
      totalAgents: jobDesc ? 5 : 4,
      percent: 5,
      message: 'Extracting text and analyzing document structure...'
    });

    const postUrl = new URL(API_URL, window.location.origin);
    const response = await fetch(postUrl.toString(), {
      method: 'POST',
      body: formData
    });

    if (!response.ok && response.status !== 202) {
      let errorMsg = `HTTP error! Status: ${response.status}`;
      try {
        const errText = await response.text();
        try {
          const errJson = JSON.parse(errText);
          errorMsg = errJson.error || errorMsg;
        } catch {
          if (errText && errText.trim().length < 500) {
            errorMsg = errText;
          }
        }
      } catch {}
      throw new Error(errorMsg);
    }

    let data = null;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep last partial line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch (e) {
            continue;
          }

          if (parsed.type === 'progress') {
            updateProgressUI(parsed);
          } else if (parsed.type === 'complete') {
            data = parsed;
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error || 'Agent evaluation failed.');
          }
        }
      }

      if (!data) {
        throw new Error('Analysis stream closed before completion.');
      }
    } else {
      let initialData;
      try {
        initialData = await response.json();
      } catch (parseErr) {
        throw new Error(`Failed to parse API response as JSON: ${parseErr.message}`);
      }

      // Asynchronous background job (Default flow - eliminates Cloudflare 524 timeouts)
      if (initialData.job_id || initialData.jobId) {
        const jobId = initialData.job_id || initialData.jobId;
        updateProgressUI({
          stage: 'extraction_done',
          completedAgents: 0,
          totalAgents: initialData.totalAgents || (jobDesc ? 5 : 4),
          percent: 15,
          message: 'Document extracted. Enqueued for multi-agent evaluation...'
        });

        const statusPath = API_URL.endsWith('/') ? `${API_URL}status/` : `${API_URL}/status/`;
        const statusUrl = new URL(`${statusPath}${encodeURIComponent(jobId)}`, window.location.origin).toString();

        const pollIntervalMs = 2000;
        const maxPollDurationMs = 15 * 60 * 1000; // 15-minute safety threshold
        const startTime = Date.now();

        while (true) {
          if (Date.now() - startTime > maxPollDurationMs) {
            throw new Error('Analysis timed out after 15 minutes. Please try again.');
          }

          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

          let statusRes;
          try {
            statusRes = await fetch(statusUrl);
          } catch (fetchErr) {
            console.warn('Network error during status poll, will retry:', fetchErr);
            continue;
          }

          if (!statusRes.ok) {
            if (statusRes.status === 404) {
              throw new Error('Job was not found on the server.');
            }
            console.warn(`Status polling received HTTP ${statusRes.status}, will retry...`);
            continue;
          }

          const jobStatus = await statusRes.json();
          updateProgressUI(jobStatus);

          if (jobStatus.status === 'complete') {
            data = jobStatus.result || jobStatus;
            break;
          } else if (jobStatus.status === 'error') {
            throw new Error(jobStatus.error || 'Optimization pipeline encountered an error.');
          }
        }
      } else {
        // Direct synchronous response
        data = initialData;
      }
    }

    const rawCritique = data.critique || "";
    let critiquePart = rawCritique;
    let resumeHtmlPart = "";

    // Regular expression to match "=== REWRITTEN RESUME ===" case-insensitively, allowing variation in equals count or markdown formatting.
    const delimiterRegex = /(?:#|\*|_)*\s*={3,}\s*REWRITTEN RESUME\s*={3,}\s*(?:#|\*|_)*/i;
    
    if (delimiterRegex.test(rawCritique)) {
      const parts = rawCritique.split(delimiterRegex);
      critiquePart = parts[0].trim();
      let rawHtml = parts[1].trim();
      
      // Clean up markdown code blocks if the model wrapped the HTML response
      rawHtml = rawHtml.replace(/^```(html)?/i, "").trim();
      rawHtml = rawHtml.replace(/```$/, "").trim();
      
      resumeHtmlPart = rawHtml;
    } else {
      critiquePart = rawCritique;
      resumeHtmlPart = `
        <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #666;">
          <p>No rewritten résumé generated. Check the Critique tab for recommendations.</p>
        </div>
      `;
    }

    currentCritiqueMarkdown = critiquePart;
    currentResumeHtml = resumeHtmlPart;

    targetPageCount = data.targetPageCount || 1;
    
    // Render Critique Markdown
    critiqueContent.innerHTML = marked.parse(currentCritiqueMarkdown);
    
    // Render Rewritten HTML Resume
    if (resumePreviewContent) {
      resumePreviewContent.innerHTML = resumeHtmlPart || `
        <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #666;">
          <p>No rewritten résumé generated. Check the Critique tab for recommendations.</p>
        </div>
      `;
      fitToPageTarget(resumePreviewContent, targetPageCount);
    }
    
    if (extractedMeta) {
      extractedMeta.textContent = `Processed ${formatBytes(data.extractedTextLength || 0)} of raw résumé text`;
    }

    // Transition to Results Card
    loadingCard.classList.add('hidden');
    resultsCard.classList.remove('hidden');

  } catch (err) {
    console.error("Critique failed:", err);
    alert(`Résumé evaluation failed:\n${err.message || err}`);
    if (window.turnstile) window.turnstile.reset();
    // Revert back to upload page
    loadingCard.classList.add('hidden');
    uploadCard.classList.remove('hidden');
  }
});

// Instantaneous client-side font sizing refinement loop to match targeted page height
function fitToPageTarget(element, targetPages) {
  if (!element || !element.innerHTML.trim() || element.innerHTML.includes('No rewritten résumé generated')) {
    return;
  }
  
  // Temporarily show resume panel if hidden to get accurate measurements
  const panelWasHidden = resumePanel && resumePanel.classList.contains('hidden');
  if (panelWasHidden) {
    resumePanel.classList.remove('hidden');
  }
  
  // Reset any previous dynamic sizing
  element.style.fontSize = "1.0em";
  
  const maxAllowedHeight = targetPages * 1050 + (targetPages - 1) * 20;
  const minRequiredHeight = (targetPages - 1) * 1123 + 750;
  
  let currentScale = 1.0;
  let height = element.scrollHeight;
  console.log(`Auto-fitting layout: current height is ${height}px. Target range: ${minRequiredHeight}px - ${maxAllowedHeight}px`);
  
  // Scale down step-by-step if too tall
  if (height > maxAllowedHeight) {
    while (element.scrollHeight > maxAllowedHeight && currentScale > 0.65) {
      currentScale -= 0.015;
      element.style.fontSize = `${currentScale}em`;
    }
    console.log(`Scaled down to ${currentScale}em. New height: ${element.scrollHeight}px`);
  }
  // Scale up step-by-step if too short (only if targetPages > 1 or it is very short)
  else if (height < minRequiredHeight) {
    const minScaleUpThreshold = targetPages === 1 ? 600 : minRequiredHeight;
    if (height < minScaleUpThreshold) {
      while (element.scrollHeight < minScaleUpThreshold && currentScale < 1.15) {
        currentScale += 0.015;
        element.style.fontSize = `${currentScale}em`;
      }
      console.log(`Scaled up to ${currentScale}em. New height: ${element.scrollHeight}px`);
    }
  }
  
  if (panelWasHidden) {
    resumePanel.classList.add('hidden');
  }
}



// Sync link text changes back to their href attributes in real-time or before downloading
function syncLinksAndGetHtml() {
  const element = document.getElementById('resume-preview-content');
  if (!element) return "";
  
  const links = element.querySelectorAll('a');
  links.forEach(link => {
    const text = link.textContent.trim();
    if (text) {
      const href = link.getAttribute('href') || '';
      
      if (text.startsWith('http://') || text.startsWith('https://')) {
        link.setAttribute('href', text);
      } else if (text.includes('@') && !text.includes('/')) {
        const email = text.replace(/^mailto:/i, '').trim();
        link.setAttribute('href', `mailto:${email}`);
      } else if (text.startsWith('www.')) {
        link.setAttribute('href', `https://${text}`);
      } else {
        // Use the original href pattern to guide partial username/handle edits
        if (href.includes('github.com') || text.includes('github.com')) {
          const username = text.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').trim();
          link.setAttribute('href', `https://github.com/${username}`);
        } else if (href.includes('linkedin.com') || text.includes('linkedin.com')) {
          const path = text.replace(/^(https?:\/\/)?(www\.)?linkedin\.com\/(in\/)?/i, '').trim();
          link.setAttribute('href', `https://www.linkedin.com/in/${path}`);
        } else if (href.startsWith('mailto:') || href.includes('@')) {
          link.setAttribute('href', `mailto:${text}`);
        } else {
          // Fallback if it looks like a domain name
          if (text.includes('.') && !text.includes(' ')) {
            link.setAttribute('href', `https://${text}`);
          }
        }
      }
    }
  });

  return element.innerHTML;
}

// Download HTML report
function handleDownloadHtml() {
  const editedHtml = syncLinksAndGetHtml();
  if (!editedHtml || editedHtml.includes('No rewritten résumé generated')) {
    alert("No rewritten résumé content available to download.");
    return;
  }
  
  // Wrap the HTML content in a proper HTML5 boilerplate to make it a standalone document
  const standaloneHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Optimized Résumé</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background-color: #ffffff;
    }
  </style>
</head>
  <body>
    ${editedHtml}
  </body>
</html>`;

  const blob = new Blob([standaloneHtml], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  
  const originalName = selectedFile ? selectedFile.name.replace(/\.(pdf|png|jpe?g)$/i, '') : 'résumé';
  link.setAttribute('download', `${originalName}_optimized.html`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

if (downloadHtmlBtn) {
  downloadHtmlBtn.addEventListener('click', handleDownloadHtml);
}
if (downloadHtmlTopBtn) {
  downloadHtmlTopBtn.addEventListener('click', handleDownloadHtml);
}

// Reset critique flow
newCritiqueBtn.addEventListener('click', () => {
  resultsCard.classList.add('hidden');
  clearSelectedFile();
  uploadCard.classList.remove('hidden');
});

// Tab Switching
if (tabCritiqueBtn && tabResumeBtn && critiquePanel && resumePanel) {
  tabCritiqueBtn.addEventListener('click', () => {
    critiquePanel.classList.remove('hidden');
    resumePanel.classList.add('hidden');
    tabCritiqueBtn.className = "text-xs bg-slate-900 border border-slate-800/80 text-indigo-400 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5 border-b-2 border-indigo-500";
    tabResumeBtn.className = "text-xs bg-slate-950/40 border border-slate-900/60 text-gray-400 hover:text-indigo-400 hover:bg-slate-900 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5";
  });

  tabResumeBtn.addEventListener('click', () => {
    resumePanel.classList.remove('hidden');
    critiquePanel.classList.add('hidden');
    tabResumeBtn.className = "text-xs bg-slate-900 border border-slate-800/80 text-indigo-400 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5 border-b-2 border-indigo-500";
    tabCritiqueBtn.className = "text-xs bg-slate-950/40 border border-slate-900/60 text-gray-400 hover:text-indigo-400 hover:bg-slate-900 px-4 py-2.5 rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5";
  });
}

// Open print window to generate high-quality searchable vector PDF using print binary-search
function handlePrintPdf() {
  const element = document.getElementById('resume-preview-content');
  if (!element || !resumePreviewContent.innerHTML.trim() || resumePreviewContent.innerHTML.includes('No rewritten résumé generated')) {
    alert("No rewritten résumé content available to download.");
    return;
  }

  // Sync edits first
  const editedHtml = syncLinksAndGetHtml();

  // Extract candidate name from DOM or filename fallback
  let candidateName = '';
  const nameEl = element.querySelector('h1') || element.querySelector('div[style*="font-size: 1.8em"]') || element.querySelector('div[style*="font-size: 1.5em"]');
  if (nameEl && nameEl.textContent.trim()) {
    candidateName = nameEl.textContent.trim();
  } else {
    candidateName = selectedFile ? selectedFile.name.replace(/\.(pdf|png|jpe?g)$/i, '').replace(/[_-]/g, ' ') : 'Optimized';
  }
  // Capitalize name cleanly to Title Case
  const formattedName = candidateName
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  const documentTitle = `${formattedName} - Résumé`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert("Please allow popups to download the PDF résumé.");
    return;
  }

  printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${documentTitle}</title>
  <style id="dynamic-page-style">
    @page {
      size: letter;
      margin: 0.4in 0.5in;
    }
  </style>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #ffffff;
      color: #000000;
      font-family: Arial, sans-serif;
    }
    #print-content {
      box-sizing: border-box;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
    /* Force bullet points and indentation on the resume content */
    ul {
      list-style-type: disc !important;
      margin-left: 1.5rem !important;
      padding-left: 0.5rem !important;
      margin-top: 0.2em !important;
      margin-bottom: 0.2em !important;
    }
    li {
      display: list-item !important;
      list-style-type: disc !important;
      margin-bottom: 0.25em !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    a {
      color: #004b93 !important;
      text-decoration: none !important;
    }
  </style>
</head>
<body>
  <div id="print-content">
    ${editedHtml}
  </div>
  <script>
    window.onload = function() {
      const element = document.getElementById('print-content');
      const pageStyle = document.getElementById('dynamic-page-style');
      const targetPages = ${targetPageCount || 1};
      const safetyFactor = targetPages === 1 ? 0.98 : (targetPages === 2 ? 0.90 : 0.88);
      const maxPageHeight = targetPages * 979 * safetyFactor; // Adjust for browser page-break padding gaps
      
      let low = 0.65;
      let high = 1.30;
      let bestScale = low;
      
      // Perform binary search to optimize printable text size and margins for page budget
      for (let i = 0; i < 8; i++) {
        const mid = (low + high) / 2;
        
        // Compute dynamic margins: narrower margins for small scales, wider for large scales
        const t = Math.max(0, Math.min(1, (mid - 0.65) / (1.30 - 0.65)));
        const lr = 0.35 + t * (0.65 - 0.35); // 0.35in (cramped) to 0.65in (spaced)
        const tb = 0.30 + t * (0.50 - 0.30); // 0.30in to 0.50in
        const w = 8.5 - (2 * lr);
        
        // Apply page margin and content width
        pageStyle.innerHTML = '@page { size: letter; margin: ' + tb + 'in ' + lr + 'in; }';
        element.style.width = w + 'in';
        element.style.fontSize = mid + 'em';
        
        void element.offsetHeight; // Force layout recalculation
        
        if (element.scrollHeight > maxPageHeight) {
          high = mid; // Too large, shrink
        } else {
          bestScale = mid; // Fits, try growing to fill page
          low = mid;
        }
      }
      
      // Re-apply the best scale and margins
      const tBest = Math.max(0, Math.min(1, (bestScale - 0.65) / (1.30 - 0.65)));
      const lrBest = 0.35 + tBest * (0.65 - 0.35);
      const tbBest = 0.30 + tBest * (0.50 - 0.30);
      const wBest = 8.5 - (2 * lrBest);
      
      pageStyle.innerHTML = '@page { size: letter; margin: ' + tbBest + 'in ' + lrBest + 'in; }';
      element.style.width = wBest + 'in';
      element.style.fontSize = bestScale + 'em';
      
      void element.offsetHeight;
      
      // Trigger native print dialog
      window.print();
      
      // Close window shortly after print dialog finishes
      setTimeout(function() {
        window.close();
      }, 500);
    };
  <\/script>
</body>
</html>
  `);
  printWindow.document.close();
}

if (downloadPdfBtn) {
  downloadPdfBtn.addEventListener('click', handlePrintPdf);
}
if (downloadPdfTopBtn) {
  downloadPdfTopBtn.addEventListener('click', handlePrintPdf);
}



// Sync edited link texts to their actual target href attributes in real-time as the user types
if (resumePreviewContent) {
  resumePreviewContent.addEventListener('input', () => {
    syncLinksAndGetHtml();
  });
}