const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const router = express.Router();

const { generateJson, HttpError, sendError, isRecord, isStringArray, requireText } = require('../utils/ai');
const { requireManager } = require('../middleware/auth');

const Project = require('../models/Project');
const AuditLog = require('../models/AuditLog');
const Message = require('../models/Message'); // Required for system triggers
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../uploads'));

for (const parameter of ['projectId', 'fileId', 'analysisId']) {
  router.param(parameter, (req, res, next, id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, error: `Invalid ${parameter}.` });
    next();
  });
}

function vaultPath(filename) {
  if (typeof filename !== 'string' || filename === '.' || filename === '..' || /[\\/\x00:]/.test(filename)) {
    throw new HttpError(400, 'Invalid vault filename.');
  }
  return path.join(uploadDir, filename);
}

async function removeUploadedFile(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to clean up vault file.');
  }
}

// ==========================================
// 🛡️ MULTER ENTERPRISE FILE STORAGE
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(uploadDir, { recursive: true }, error => cb(error, uploadDir));
  },
  filename: (req, file, cb) => {
    cb(null, randomUUID() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ==========================================
// 📂 GLOBAL & STATIC ROUTES 
// ==========================================
router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve immutable audit logs.' });
  }
});

router.get('/workspace-integrations', (req, res) => res.status(501).json({
  success: false,
  error: 'Workspace repository synchronization and Webex provisioning are unavailable: no connector is implemented.'
}));

router.get('/download/:filename', (req, res) => {
  try {
    const filePath = vaultPath(req.params.filename);
    res.download(filePath, error => {
      if (error && !res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 500).json({ success: false, error: 'File unavailable on server.' });
    });
  } catch (error) {
    sendError(res, error, 'Failed to download file.');
  }
});

router.get('/', async (req, res) => {
  try {
    const projects = await Project.find()
      .populate('aiShortlistedTeam.employeeId', 'name role skills')
      .populate('allocatedTasks.assignedTo', 'name role')
      .sort({ createdAt: -1 });
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve enterprise projects.' });
  }
});

// DELETE: 🚨 EMERGENCY PURGE - Clear all data (For Hackathon Resets)
router.delete('/admin/purge-all', (req, res, next) => {
  if (process.env.ENABLE_DESTRUCTIVE_RESET !== 'true' || process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Destructive resets are disabled.' });
  }
  return requireManager(req, res, next);
}, async (req, res) => {
  try {
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      for (const file of files) {
        const filePath = vaultPath(file);
        if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
      }
    }
    await Project.deleteMany({});
    await AuditLog.deleteMany({});
    res.json({ success: true, message: 'Enterprise database completely wiped and reset.' });
  } catch (err) {
    console.error("Purge Error:", err);
    res.status(500).json({ success: false, error: 'Failed to purge database.' });
  }
});

// ==========================================
// 📂 DYNAMIC PROJECT ROUTES
// ==========================================
router.get('/:projectId', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) return res.status(400).json({ success: false, error: 'Invalid Project ID format.' });
    const project = await Project.findById(req.params.projectId).populate('aiShortlistedTeam.employeeId', 'name role skills').populate('allocatedTasks.assignedTo', 'name role');
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
    res.json({ success: true, project });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve project details.' });
  }
});

router.put('/:projectId/status', async (req, res) => {
  try {
    const { status, userId, reason } = req.body || {};
    if (!Project.schema.path('status').enumValues.includes(status)) throw new HttpError(400, 'Invalid project status.');
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) return res.status(400).json({ success: false, error: 'Invalid Project ID format.' });
    
    const project = await Project.findByIdAndUpdate(req.params.projectId, { $set: { status: status } }, { new: true, runValidators: true });
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    let actionType = 'WORKFLOW_STATE_CHANGE';
    let details = `Project status manually updated to: ${status}`;
    let securityLevel = 'Standard';

    if (status === 'QA Review') { actionType = 'CI_CD_PIPELINE_SUCCESS'; details = `Automated Pipeline Passed. Sent to QA Review.`; securityLevel = 'Elevated'; } 
    else if (status === 'In Progress' && reason) { actionType = 'QA_SECURITY_REJECTION'; details = `Build Rejected by QA. Reason: ${reason}`; securityLevel = 'Critical'; } 
    else if (status === 'Completed' || status === 'Deployed') { actionType = 'PRODUCTION_DEPLOYMENT'; details = `QA Approved. Project shipped to Production environment.`; securityLevel = 'Elevated'; }

    try { await AuditLog.create({ actionType, performedBy: userId || 'System_Auto', resourceId: project._id, details, securityLevel }); } catch (e) {}
    res.json({ success: true, project });
  } catch (err) {
    sendError(res, err, 'Failed to execute state transition.');
  }
});

// ==========================================
// 🗄️ PROJECT FILE VAULT ROUTES
// ==========================================
router.post('/:projectId/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file provided.' });
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) return res.status(400).json({ success: false, error: 'Invalid Project ID.' });

    const project = await Project.findById(req.params.projectId);
    if (!project) {
      await removeUploadedFile(req.file.path);
      return res.status(404).json({ success: false, error: 'Project not found.' });
    }

    const newFile = { originalName: req.file.originalname, filename: req.file.filename, path: req.file.path, mimetype: req.file.mimetype, size: req.file.size, uploadedBy: req.body.uploaderName || 'Unknown User' };
    project.files.push(newFile);
    await project.save();
    res.json({ success: true, file: project.files[project.files.length - 1], message: 'File securely vaulted.' });
  } catch (err) {
    await removeUploadedFile(req.file?.path);
    res.status(500).json({ success: false, error: 'Failed to upload file.' });
  }
});

router.delete('/:projectId/files/:fileId', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) return res.status(400).json({ success: false, error: 'Invalid ID.' });
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    const fileToDelete = project.files.id(req.params.fileId);
    if (fileToDelete) {
      const filePath = vaultPath(fileToDelete.filename);
      project.files.pull(req.params.fileId);
      await project.save();
      await removeUploadedFile(filePath);
      res.json({ success: true, message: 'File successfully deleted.' });
    } else {
      res.status(404).json({ success: false, error: 'File not found.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete file.' });
  }
});

// ==========================================
// 🧠 AI VAULT ANALYZER ROUTES
// ==========================================
router.post('/:projectId/vault-analysis', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    const fileNames = project.files.map(f => f.originalName).join(', ');
    const requesterName = req.body?.requesterName || 'System User';
    if (!project.files.length) throw new HttpError(400, 'Upload at least one file before requesting vault analysis.');
    const prompt = `You are a Senior Technical Project Manager. Project Name: ${project.title}.
      The team uploaded these files: ${fileNames}.
      Only filenames and project context are available; file contents have NOT been read.
      State this limitation and suggest a review plan without claiming to have verified document contents.
      Use EXACT JSON schema:
      {
        "projectSummary": "A 4-sentence executive summary.",
        "analysisWorkflows": [ "Details on how to decompose specific features.", "Cross-referencing logic to verify timelines." ],
        "businessRequirements": [ "Project Vision & Goals: ...", "Success Metrics (KPIs): ...", "Stakeholders: ..." ],
        "functionalReqs": [ "User Personas: ...", "Prioritized Feature List: ...", "Business Rules: ..." ],
        "nonFunctionalReqs": [ "Performance Limits: ...", "Availability & Uptime: ...", "Usability: ..." ],
        "securityMeasures": [ "Data Encryption Standards: ...", "Authentication Protocols: ...", "Compliance: ..." ],
        "technicalEnv": [ "Required Tech Stack: ...", "Cloud Infrastructure: ...", "API Integrations: ..." ],
        "constraints": [ "Estimated Budget/Timeline limits: ...", "Legal/Industry Dependencies: ..." ]
      }`;
      
    const insight = await generateJson(prompt, value => typeof value.projectSummary === 'string'
      && ['analysisWorkflows', 'businessRequirements', 'functionalReqs', 'nonFunctionalReqs', 'securityMeasures', 'technicalEnv', 'constraints'].every(key => isStringArray(value[key])), { temperature: 0.2 });
    const insightContent = JSON.stringify(insight);

    const newAnalysis = { title: `Deep Vault Scan: ${new Date().toLocaleDateString()}`, content: insightContent, generatedBy: requesterName };
    project.vaultAnalyses.push(newAnalysis);
    await project.save();

    res.json({ success: true, analysis: project.vaultAnalyses[project.vaultAnalyses.length - 1], message: 'Filename-based review plan generated and saved.' });
  } catch (err) {
    sendError(res, err, 'Failed to generate AI analysis.');
  }
});

router.delete('/:projectId/vault-analysis/:analysisId', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
    if (!project.vaultAnalyses.id(req.params.analysisId)) return res.status(404).json({ success: false, error: 'Analysis not found.' });
    project.vaultAnalyses.pull(req.params.analysisId);
    await project.save();
    res.json({ success: true, message: 'Analysis permanently deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete analysis.' });
  }
});

// ==========================================
// 🐝 AUTONOMOUS AGENT SWARM ROUTE
// ==========================================
router.post('/:projectId/agent-swarm', async (req, res) => {
  try {
    const { codeSnippet, errorLogs } = req.body || {};
    requireText(codeSnippet, 'Code snippet');
    if (errorLogs !== undefined && typeof errorLogs !== 'string') throw new HttpError(400, 'Error context must be a string.');
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    const prompt = `
      You are simulating an autonomous "Agent Swarm" debugging software.
      Code Snippet: ${codeSnippet}
      Error/Context: ${errorLogs}

      Simulate a rapid-fire technical debate between 3 AI agents:
      1. "Arch-AI" (Architectural design & structure)
      2. "Sec-AI" (Cybersecurity & vulnerability patching)
      3. "QA-AI" (Testing & edge cases)

      Required EXACT JSON Schema:
      {
        "swarmDebate": [
          { "agent": "Arch-AI", "message": "..." },
          { "agent": "Sec-AI", "message": "..." },
          { "agent": "QA-AI", "message": "..." }
        ],
        "consensusReached": "Summary of consensus.",
        "finalPatchedCode": "Fully corrected code block."
      }
    `;

    const swarmData = await generateJson(prompt, value => Array.isArray(value.swarmDebate)
      && value.swarmDebate.length > 0 && value.swarmDebate.every(turn => isRecord(turn)
        && typeof turn.agent === 'string' && typeof turn.message === 'string')
      && typeof value.consensusReached === 'string' && typeof value.finalPatchedCode === 'string', { temperature: 0.3 });
    res.json({ success: true, swarmData });
  } catch (err) {
    sendError(res, err, 'Agent Swarm simulation failed.');
  }
});

// ==========================================
// Save a suggested patch for review
// ==========================================
router.post('/:projectId/apply-patch', async (req, res) => {
  let filePath;
  let saved = false;
  try {
    const { patchedCode, commitMessage, uploaderName } = req.body || {};
    requireText(patchedCode, 'Patched code');
    const project = await Project.findById(req.params.projectId);

    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    // Store the suggested patch as a vault artifact; this does not execute code or modify a repository.
    const fileName = `SwarmFix-${randomUUID()}.js`;
    filePath = vaultPath(fileName);
    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filePath, patchedCode, { flag: 'wx' });

    // 2. Vault the physical file in MongoDB
    const newFile = {
      originalName: fileName,
      filename: fileName,
      path: filePath,
      mimetype: 'application/javascript',
      size: Buffer.byteLength(patchedCode, 'utf8'),
      uploadedBy: uploaderName || 'Agent Swarm'
    };

    project.files.push(newFile);
    await project.save();
    saved = true;

    // 3. Announce the saved artifact without failing a successful save on notification errors.
    const io = req.app.get('io');
    if (io) {
      try {
        const announcement = await Message.create({
          author: 'WorkSphere Bot',
          role: 'Patch Review',
          isBot: true,
          channel: 'engineering',
          urgent: false,
          text: `Suggested patch saved to project vault.\n\nFile: ${fileName}\nSummary: ${typeof commitMessage === 'string' ? commitMessage : 'Review the suggested patch before applying it to your repository.'}`
        });
        io.emit('receive_message', announcement);
      } catch (error) {
        console.error('Patch saved, but chat notification failed.');
      }
    }

    res.json({ success: true, file: project.files[project.files.length - 1], message: 'Suggested patch saved to the vault for review.' });
  } catch (err) {
    if (!saved) await removeUploadedFile(filePath);
    sendError(res, err, 'Failed to save suggested patch.');
  }
});

module.exports = router;
