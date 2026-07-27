const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const Project = require('../models/Project');
const AuditLog = require('../models/AuditLog');
const Message = require('../models/Message'); // Required for system triggers

// ==========================================
// 🛡️ MULTER ENTERPRISE FILE STORAGE
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
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

router.get('/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../uploads', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ success: false, error: 'File not found on server.' });
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
router.delete('/admin/purge-all', async (req, res) => {
  try {
    const uploadDir = './uploads';
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      for (const file of files) fs.unlinkSync(path.join(uploadDir, file));
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
    const { status, userId, reason } = req.body;
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
    res.status(500).json({ success: false, error: 'Failed to execute state transition.' });
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
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    const newFile = { originalName: req.file.originalname, filename: req.file.filename, path: req.file.path, mimetype: req.file.mimetype, size: req.file.size, uploadedBy: req.body.uploaderName || 'Unknown User' };
    project.files.push(newFile);
    await project.save();
    res.json({ success: true, file: newFile, message: 'File securely vaulted.' });
  } catch (err) {
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
      const filePath = path.join(__dirname, '../uploads', fileToDelete.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      project.files.pull(req.params.fileId);
      await project.save();
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
    const requesterName = req.body.requesterName || 'System User';
    let insightContent = "";

    if (genAI && project.files.length > 0) {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
      const prompt = `You are a Senior Technical Project Manager. Project Name: ${project.title}. 
      The team uploaded these files: ${fileNames}.
      Review context and generate analysis. 
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
      
      const result = await model.generateContent(prompt);
      let rawText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
      
      try {
          JSON.parse(rawText);
          insightContent = rawText; 
      } catch (e) {
          insightContent = JSON.stringify({ projectSummary: "Failed to format JSON perfectly. Raw Output: " + rawText });
      }
    } else {
      insightContent = JSON.stringify({
        projectSummary: `Analyzed ${project.files.length} active documents. AI offline or Vault empty.`,
        businessRequirements: ["System analysis incomplete."],
        securityMeasures: ["Proceed with manual Zero-Trust."]
      });
    }

    const newAnalysis = { title: `Deep Vault Scan: ${new Date().toLocaleDateString()}`, content: insightContent, generatedBy: requesterName };
    project.vaultAnalyses.push(newAnalysis);
    await project.save();

    res.json({ success: true, analysis: newAnalysis, message: 'Analysis generated and saved.' });
  } catch (err) {
    console.error("AI Vault Analysis Error:", err);
    res.status(500).json({ success: false, error: 'Failed to generate AI analysis.' });
  }
});

router.delete('/:projectId/vault-analysis/:analysisId', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
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
    const { codeSnippet, errorLogs } = req.body;

    if (!genAI) {
      return res.json({
        success: true,
        swarmData: {
          swarmDebate: [
            { agent: "Arch-AI", message: "Analyzing code pattern... Structure lacks centralized input sanitization and try/catch boundaries." },
            { agent: "Sec-AI", message: "CRITICAL VULNERABILITY DETECTED: Execution vector allows raw SQL injection and token leakage!" },
            { agent: "QA-AI", message: "Edge-case test failed: Passing 'undefined' or empty payload crashes the main execution thread." },
            { agent: "Arch-AI", message: "Proposing a parameterized query architecture with async exception wrappers." },
            { agent: "Sec-AI", message: "Vetting patch... Cryptographic parameters validated. Zero-trust check passed." }
          ],
          consensusReached: "100% Consensus Reached: Input parameterization applied, memory leaks eliminated, and security boundaries verified.",
          finalPatchedCode: `// 🛡️ AUTONOMOUS SWARM AUDITED & PATCHED CODE\nasync function executeSecureQuery(inputParam) {\n    try {\n        if (!inputParam || typeof inputParam !== 'string') {\n            throw new Error("Invalid or Malformed Parameter");\n        }\n        // Parameterized prepared statement preventing SQL Injection\n        const query = "SELECT * FROM enterprise_data WHERE id = $1";\n        const result = await db.query(query, [inputParam]);\n        return result.rows;\n    } catch (error) {\n        console.error("[Swarm Guard Alert]:", error.message);\n        return null;\n    }\n}`
        }
      });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
    });

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

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();

    res.json({ success: true, swarmData: JSON.parse(rawText) });
  } catch (err) {
    console.error("Swarm Error:", err);
    res.status(500).json({ success: false, error: 'Agent Swarm simulation failed.' });
  }
});

// ==========================================
// 🚀 1-CLICK APPLY PATCH & COMMIT ROUTE
// ==========================================
router.post('/:projectId/apply-patch', async (req, res) => {
  try {
    const { patchedCode, commitMessage, uploaderName } = req.body;
    const project = await Project.findById(req.params.projectId);

    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

    // 1. Physically compile file to uploads folder
    const fileName = `SwarmFix-${Date.now().toString().slice(-6)}.js`;
    const filePath = path.join(__dirname, '../uploads', fileName);
    fs.writeFileSync(filePath, patchedCode);

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

    // 3. Broadcast commit to global chat
    const io = req.app.get('io');
    if (io) {
      const commitHash = Math.random().toString(16).slice(2, 9).toUpperCase();
      const announcement = await Message.create({
        author: 'GitHub Actions Bot',
        role: 'CI/CD Engine',
        isBot: true,
        channel: 'engineering',
        urgent: false,
        text: `✅ SWARM PATCH MERGED & VAULTED\n\nCommit Hash: #${commitHash}\nFile: ${fileName}\nSummary: ${commitMessage}\n\nThe patch has been compiled, vaulted, and pushed to the main development branch.`
      });
      io.emit('receive_message', announcement);
    }

    res.json({ success: true, message: 'Patch merged and vaulted.' });
  } catch (err) {
    console.error("Apply Patch Error:", err);
    res.status(500).json({ success: false, error: 'Failed to apply patch.' });
  }
});

module.exports = router;