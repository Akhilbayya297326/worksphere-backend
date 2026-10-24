const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { generateJson, HttpError, sendError, requireText, isRecord, isStringArray } = require('../utils/ai');

const Project = require('../models/Project');
const Employee = require('../models/Employee');
const Message = require('../models/Message');

// Memory storage for fast multimodal image buffer parsing (Whiteboard Vision)
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, fieldSize: 10000 },
  fileFilter: (req, file, callback) => callback(imageTypes.has(file.mimetype) ? null
    : new HttpError(400, 'Upload a PNG, JPEG, WebP, HEIC, or HEIF image.'), imageTypes.has(file.mimetype))
});
const uploadImage = (req, res, next) => uploadMemory.single('image')(req, res, error => {
  if (!error) return next();
  return sendError(res, error instanceof multer.MulterError
    ? new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 10 MB or smaller.' : 'Invalid image upload.') : error,
  'Failed to upload whiteboard image.');
});

function validateProjectId(value) {
  if (!mongoose.isObjectIdOrHexString(value)) throw new HttpError(400, 'Invalid project ID.');
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 100) {
    throw new HttpError(400, 'Provide between 1 and 100 finalized tasks.');
  }
  return tasks.map(task => {
    if (!isRecord(task)) throw new HttpError(400, 'Each task must be an object.');
    if (task.description !== undefined && typeof task.description !== 'string') throw new HttpError(400, 'Task description must be a string.');
    const complexity = task.complexity ?? 'Medium';
    if (!['Low', 'Medium', 'High', 'Critical'].includes(complexity)) throw new HttpError(400, 'Invalid task complexity.');
    return {
      title: requireText(task.title, 'Task title', 500), description: task.description || '', complexity,
      assignedTo: requireText(task.assignedTo, 'Assigned employee', 200),
      status: 'To Do'
    };
  });
}

async function resolveTasks(tasks, team = []) {
  const assignments = tasks.map(task => task.assignedTo);
  const names = [...new Set([...assignments, ...team.map(person => person.name)])];
  const ids = assignments.filter(value => mongoose.isObjectIdOrHexString(value));
  const employees = await Employee.find({ $or: [{ name: { $in: names } }, { _id: { $in: ids } }] });
  const resolvedTasks = tasks.map(task => {
    const idMatch = employees.find(employee => String(employee._id).toLowerCase() === task.assignedTo.toLowerCase());
    const nameMatches = employees.filter(employee => employee.name === task.assignedTo);
    const employee = idMatch || (nameMatches.length === 1 ? nameMatches[0] : null);
    if (!employee) throw new HttpError(400, 'An assigned employee does not exist or has an ambiguous name. Refresh the team and try again.');
    return { ...task, assignedTo: employee._id };
  });
  const resolvedTeam = team.map(person => {
    const matches = employees.filter(employee => employee.name === person.name);
    const employee = matches.find(item => String(item._id) === person.employeeId) || (matches.length === 1 ? matches[0] : null);
    if (!employee) throw new HttpError(400, 'A shortlisted employee does not exist or has an ambiguous name. Refresh the team and try again.');
    return { employeeId: employee._id, name: employee.name, role: employee.role, reason: person.reason || person.matchReason || '' };
  });
  return { tasks: resolvedTasks, team: resolvedTeam };
}

// ============================================================================
// ROUTE 1: MULTIMODAL WHITEBOARD VISION ORCHESTRATOR
// ============================================================================
router.post('/vision-orchestrate', uploadImage, async (req, res) => {
  try {
    const title = requireText(req.body?.title, 'Project title', 500);
    const file = req.file;
    if (!file || !file.buffer?.length) throw new HttpError(400, 'A whiteboard image is required.');
    if (!imageTypes.has(file.mimetype)) throw new HttpError(400, 'Unsupported image type.');
    if (!process.env.GEMINI_API_KEY?.trim()) throw new HttpError(503, 'AI service is not configured. Set GEMINI_API_KEY on the backend.');

    const availableTalent = await Employee.find({ availability: 'Available' }).select('name role skills technologiesKnown');
    if (!availableTalent.length) throw new HttpError(400, 'No available employees found for this project.');

    const imageBase64 = file.buffer.toString('base64');
    const imagePart = { inlineData: { data: imageBase64, mimeType: file.mimetype } };

    const prompt = `
      You are an elite Principal Software Architect.
      Analyze this image of a whiteboard sketch/wireframe/diagram for the project titled "${title}".

      AVAILABLE TALENT POOL:
      ${JSON.stringify(availableTalent)}

      TASK:
      1. Interpret the visual structure, flow, and architecture depicted in the drawing.
      2. Generate EXACTLY 10 to 15 granular technical sprint tasks required to build this vision into software.
      3. Shortlist 3-4 key employees from the Talent Pool to execute this initiative.

      JSON Schema Requirement:
      {
        "shortlistedTeam": [
          { "name": "<Employee Name>", "role": "<Role>", "matchReason": "<Why they fit this visual blueprint>" }
        ],
        "draftedTasks": [
          { "title": "<Task Title>", "description": "<Task description derived from drawing>", "complexity": "Low/Medium/High", "assignedTo": "<Suggested Employee Name>" }
        ]
      }
    `;

    const parsedData = await generateJson([prompt, imagePart], data =>
      Array.isArray(data.shortlistedTeam) && data.shortlistedTeam.every(person => isRecord(person) && typeof person.name === 'string') &&
      Array.isArray(data.draftedTasks) && data.draftedTasks.length > 0 && data.draftedTasks.length <= 100 &&
      data.draftedTasks.every(task => isRecord(task) && typeof task.title === 'string' && task.title.trim() &&
        typeof task.description === 'string' && ['Low', 'Medium', 'High'].includes(task.complexity)), { temperature: 0.2 });
    parsedData.shortlistedTeam = parsedData.shortlistedTeam.flatMap(person => {
      const employee = availableTalent.find(item => item.name === person.name);
      return employee ? [{ name: employee.name, role: employee.role, matchReason: typeof person.matchReason === 'string' ? person.matchReason : '' }] : [];
    });
    if (!parsedData.shortlistedTeam.length) throw new HttpError(502, 'AI service did not select any available employees. Please try again.');

    res.json({
      success: true,
      projectTitle: title,
      shortlistedTeam: parsedData.shortlistedTeam,
      draftedTasks: parsedData.draftedTasks
    });
  } catch (err) {
    sendError(res, err, 'Failed to parse whiteboard drawing.');
  }
});

// ============================================================================
// ROUTE 2: DEEP AI DRAFTING & KNOWLEDGE BASE GENERATION (Text/SRS based)
// ============================================================================
router.post('/draft-plan/:projectId', async (req, res) => {
  try {
    validateProjectId(req.params.projectId);
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: "Project not found." });

    const availableTalent = await Employee.find({ availability: 'Available' }).select('_id name role skills technologiesKnown experienceYears');

    if (!availableTalent || availableTalent.length === 0) return res.status(400).json({ success: false, error: "No available talent found for drafting." });

    const cleanTalentPool = availableTalent.map(emp => ({
      id: emp._id.toString(), name: emp.name, role: emp.role, skills: emp.skills, technologies: emp.technologiesKnown, experience: emp.experienceYears
    }));

    const prompt = `
      Act as the Tech Lead / Engineering Manager helper.
      Review the project's technical stack: ${project.analysis?.technicalRequirements?.techStack?.join(', ') || 'General IT'}
      AVAILABLE EMPLOYEES: ${JSON.stringify(cleanTalentPool)}

      TASK:
      1. Shortlist a highly capable team from the Available Employees.
      2. Draft 3-5 specific development and testing tasks. DO NOT assign them to employees yet.
      3. Generate a comprehensive 'Project Knowledge Base' that developers and testers can read.
      CRITICAL RULE: All values inside 'projectKnowledgeBase' MUST be a single String. DO NOT use JSON Arrays.

      JSON Schema Requirement:
      {
        "shortlistedTeam": [ { "employeeId": "<exact id string>", "name": "<name>", "role": "<role>", "matchReason": "<justification>" } ],
        "draftedTasks": [ { "title": "<Task Title>", "description": "<Task Details>", "complexity": "<Low/Medium/High>" } ],
        "projectKnowledgeBase": {
          "systemArchitecture": "<Single paragraph string explaining architecture>",
          "coreFeatures": "<Single string listing features (use commas or dashes)>",
          "databaseDesign": "<Single paragraph string explaining data flow>",
          "setupInstructions": "<Single string listing setup steps>",
          "qaTestingStrategy": "<Single string explaining QA approach>"
        }
      }
    `;

    const kbKeys = ['systemArchitecture', 'coreFeatures', 'databaseDesign', 'setupInstructions', 'qaTestingStrategy'];
    const draftData = await generateJson(prompt, data =>
      Array.isArray(data.shortlistedTeam) && data.shortlistedTeam.length > 0 &&
      data.shortlistedTeam.every(person => isRecord(person) && typeof person.employeeId === 'string' &&
        availableTalent.some(employee => String(employee._id) === person.employeeId)) &&
      Array.isArray(data.draftedTasks) && data.draftedTasks.length > 0 && data.draftedTasks.length <= 100 &&
      data.draftedTasks.every(task => isRecord(task) && typeof task.title === 'string' && task.title.trim() &&
        typeof task.description === 'string' && ['Low', 'Medium', 'High'].includes(task.complexity)) &&
      isRecord(data.projectKnowledgeBase) && kbKeys.every(key =>
        typeof data.projectKnowledgeBase[key] === 'string' || isStringArray(data.projectKnowledgeBase[key])), { temperature: 0.2 });

    const kb = draftData.projectKnowledgeBase;
    for (const key of kbKeys) if (Array.isArray(kb[key])) kb[key] = kb[key].join('\n');

    project.aiShortlistedTeam = draftData.shortlistedTeam.map(person => {
      const employee = availableTalent.find(item => String(item._id) === person.employeeId);
      return { employeeId: employee._id, name: employee.name, role: employee.role, reason: typeof person.matchReason === 'string' ? person.matchReason : '' };
    });
    project.projectKnowledgeBase = draftData.projectKnowledgeBase; 
    await project.save();

    res.json({ success: true, project, draftedTasks: draftData.draftedTasks });
  } catch (err) {
    sendError(res, err, 'AI drafting failed.');
  }
});

// ============================================================================
// ROUTE 3: MANAGER CONFIRMS ALLOCATION
// ============================================================================
router.post('/confirm-allocation/:projectId', async (req, res) => {
  try {
    validateProjectId(req.params.projectId);
    const tasks = normalizeTasks(req.body?.finalizedTasks);
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: "Project not found." });

    const resolved = await resolveTasks(tasks);
    project.allocatedTasks = resolved.tasks;
    project.status = 'Development'; 
    await project.save();
    
    res.json({ success: true, project });
  } catch (err) {
    sendError(res, err, 'Manager confirmation failed.');
  }
});

// ============================================================================
// ROUTE 4: DISPATCH INITIATIVE TO WORKSPACE & LIVE CHAT BROADCAST
// ============================================================================
router.post('/dispatch', async (req, res) => {
  try {
    const { title, aiShortlistedTeam = [], finalizedTasks, repositories = [] } = req.body || {};
    const projectTitle = requireText(title ?? 'Enterprise Initiative', 'Project title', 500);
    const tasks = normalizeTasks(finalizedTasks);
    if (!Array.isArray(aiShortlistedTeam) || aiShortlistedTeam.length > 100 ||
      aiShortlistedTeam.some(person => !isRecord(person) || typeof person.name !== 'string' || !person.name.trim() ||
        (person.reason !== undefined && typeof person.reason !== 'string') ||
        (person.matchReason !== undefined && typeof person.matchReason !== 'string'))) {
      throw new HttpError(400, 'Invalid shortlisted team.');
    }
    if (!Array.isArray(repositories) || repositories.length > 20) throw new HttpError(400, 'Invalid repository list.');
    const cleanRepositories = repositories.map(repository => {
      if (!isRecord(repository) || !['Frontend', 'Backend', 'Fullstack', 'Microservice', 'Other'].includes(repository.repoType)) {
        throw new HttpError(400, 'Invalid repository type.');
      }
      let url;
      try { url = new URL(requireText(repository.url, 'Repository URL', 2000)); } catch { throw new HttpError(400, 'Invalid repository URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, 'Repository URL must use HTTP or HTTPS without credentials.');
      return { repoType: repository.repoType, url: url.href };
    });
    const resolved = await resolveTasks(tasks, aiShortlistedTeam);
    const tasksWithIds = resolved.tasks;

    const newProject = await Project.create({
      title: projectTitle,
      status: 'In Progress',
      aiShortlistedTeam: resolved.team,
      allocatedTasks: tasksWithIds,
      repositories: cleanRepositories
    });

    // 🚀 Broadcast system alert to Comm-Link
    try {
      const io = req.app.get('io');
      const teamNames = resolved.team.map(t => t.name).join(', ') || 'Allocated Staff';

      const announcement = await Message.create({
        author: 'WorkSphere Orchestrator',
        role: 'System Intelligence',
        isBot: true,
        channel: 'global-orchestration',
        urgent: false,
        text: `🚀 ORCHESTRATION DISPATCHED: "${newProject.title}"\n\n📋 Team: ${teamNames}\n⚡ Tasks: ${tasksWithIds.length} Granular Units Created\n🔗 Repositories Bound: ${repositories?.length || 0}\n📅 Date: ${new Date().toLocaleDateString()}`
      });

      if (io) io.emit('receive_message', announcement);
    } catch (e) {
      console.error('Chat broadcast failed after project creation.');
    }

    res.json({ success: true, project: newProject });
  } catch (err) {
    sendError(res, err, 'Failed to dispatch initiative.');
  }
});

module.exports = router;
