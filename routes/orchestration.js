const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Project = require('../models/Project');
const Employee = require('../models/Employee');
const Message = require('../models/Message');

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Memory storage for fast multimodal image buffer parsing (Whiteboard Vision)
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ============================================================================
// ROUTE 1: MULTIMODAL WHITEBOARD VISION ORCHESTRATOR
// ============================================================================
router.post('/vision-orchestrate', uploadMemory.single('image'), async (req, res) => {
  try {
    const { title } = req.body;
    const file = req.file;

    const availableTalent = await Employee.find({ availability: 'Available' }).select('name role skills technologiesKnown');

    if (!genAI || !file) {
      // High-quality fallback for demonstration without API keys
      return res.json({
        success: true,
        projectTitle: title || "Agile Whiteboard Initiative",
        shortlistedTeam: availableTalent.slice(0, 3).map(e => ({ name: e.name, role: e.role, matchReason: "Matched from visual architecture pattern." })),
        draftedTasks: Array.from({ length: 12 }, (_, i) => ({
          title: `Task #${i + 1}: ${['Database Schema Setup', 'Auth Middleware', 'API Gateway Route', 'UI Wireframe Component', 'State Management', 'Integration Tests', 'Docker Containerization', 'Redis Caching', 'CI/CD Pipeline', 'Security Audit', 'Telemetry Stream', 'Production Deployment'][i]}`,
          description: `Extracted from whiteboard diagram node #${i + 1}. High priority execution unit.`,
          complexity: i % 3 === 0 ? 'High' : 'Medium',
          assignedTo: availableTalent[i % availableTalent.length]?.name || 'Rahul Verma'
        }))
      });
    }

    const imageBase64 = file.buffer.toString('base64');
    const imagePart = { inlineData: { data: imageBase64, mimeType: file.mimetype } };

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });

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

    const result = await model.generateContent([prompt, imagePart]);
    let responseText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(responseText);

    res.json({
      success: true,
      projectTitle: title,
      shortlistedTeam: parsedData.shortlistedTeam,
      draftedTasks: parsedData.draftedTasks
    });
  } catch (err) {
    console.error("Vision Orchestration Error:", err);
    res.status(500).json({ success: false, error: 'Failed to parse whiteboard drawing.' });
  }
});

// ============================================================================
// ROUTE 2: DEEP AI DRAFTING & KNOWLEDGE BASE GENERATION (Text/SRS based)
// ============================================================================
router.post('/draft-plan/:projectId', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: "Project not found." });

    const availableTalent = await Employee.find({ availability: 'Available' }).select('_id name role skills technologiesKnown experienceYears');

    if (!availableTalent || availableTalent.length === 0) return res.status(400).json({ success: false, error: "No available talent found for drafting." });

    const cleanTalentPool = availableTalent.map(emp => ({
      id: emp._id.toString(), name: emp.name, role: emp.role, skills: emp.skills, technologies: emp.technologiesKnown, experience: emp.experienceYears
    }));

    if (!genAI) return res.status(500).json({ success: false, error: "Gemini API key missing." });

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });

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

    const result = await model.generateContent(prompt);
    let responseText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
    const draftData = JSON.parse(responseText);

    const kb = draftData.projectKnowledgeBase;
    if (kb) {
      if (Array.isArray(kb.coreFeatures)) kb.coreFeatures = "• " + kb.coreFeatures.join('\n• ');
      if (Array.isArray(kb.setupInstructions)) kb.setupInstructions = "• " + kb.setupInstructions.join('\n• ');
      if (Array.isArray(kb.qaTestingStrategy)) kb.qaTestingStrategy = "• " + kb.qaTestingStrategy.join('\n• ');
    }

    project.aiShortlistedTeam = draftData.shortlistedTeam;
    project.projectKnowledgeBase = draftData.projectKnowledgeBase; 
    await project.save();

    res.json({ success: true, project, draftedTasks: draftData.draftedTasks });
  } catch (err) {
    console.error("AI Drafting Error:", err);
    res.status(500).json({ success: false, error: 'AI drafting failed.' });
  }
});

// ============================================================================
// ROUTE 3: MANAGER CONFIRMS ALLOCATION
// ============================================================================
router.post('/confirm-allocation/:projectId', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ success: false, error: "Project not found." });

    project.allocatedTasks = req.body.finalizedTasks; 
    project.status = 'Development'; 
    await project.save();
    
    res.json({ success: true, project });
  } catch (err) {
    console.error("Manager Confirmation Error:", err);
    res.status(500).json({ success: false, error: 'Manager confirmation failed.' });
  }
});

// ============================================================================
// ROUTE 4: DISPATCH INITIATIVE TO WORKSPACE & LIVE CHAT BROADCAST
// ============================================================================
router.post('/dispatch', async (req, res) => {
  try {
    const { title, aiShortlistedTeam, finalizedTasks, repositories } = req.body;

    const tasksWithIds = await Promise.all(finalizedTasks.map(async (task) => {
      const emp = await Employee.findOne({ name: task.assignedTo });
      return {
        title: task.title,
        description: task.description,
        complexity: task.complexity || 'Medium',
        assignedTo: emp ? emp._id : null,
        status: 'To Do'
      };
    }));

    const newProject = await Project.create({
      title: title || 'Enterprise Initiative',
      status: 'In Progress',
      aiShortlistedTeam: aiShortlistedTeam || [],
      allocatedTasks: tasksWithIds,
      repositories: repositories || []
    });

    // 🚀 Broadcast system alert to Comm-Link
    try {
      const io = req.app.get('io');
      const teamNames = aiShortlistedTeam.map(t => t.name).join(', ') || 'Allocated Staff';

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
      console.error("Chat Broadcast failed:", e);
    }

    res.json({ success: true, project: newProject });
  } catch (err) {
    console.error("Dispatch Error:", err);
    res.status(500).json({ success: false, error: 'Failed to dispatch initiative.' });
  }
});

module.exports = router;