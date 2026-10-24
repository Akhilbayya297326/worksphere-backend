const express = require('express');
const router = express.Router();
const { generateJson, HttpError, sendError, requireText, isRecord } = require('../utils/ai');
const Employee = require('../models/Employee'); // We pull this to give the AI live DB context

// POST: Elite Enterprise Document Analysis & Workforce Routing
router.post('/analyze-doc', async (req, res) => {
  try {
    const { text, documentData } = req.body || {};
    const contentToAnalyze = requireText(text ?? documentData, 'Document text');
    if (!process.env.GEMINI_API_KEY?.trim()) throw new HttpError(503, 'AI service is not configured. Set GEMINI_API_KEY on the backend.');

    // 1. Fetch live workforce data to simulate the "Find Employees Tool"
    const availableWorkforce = await Employee.find({ availability: 'Available' }).select('name role skills experienceYears');
    const workforceContext = availableWorkforce.map(emp => 
      `Name: ${emp.name}, Role: ${emp.role}, Skills: ${(emp.skills || []).join(', ')}`
    ).join('\n');
    if (!availableWorkforce.length) throw new HttpError(400, 'No available employees found for this project.');
    
    const prompt = `
      You are an Elite Enterprise Software Architect and WorkSphere AI, an expert resource allocation AI. 
      Your goal is to conduct a deep Document Analysis Procedure (Extraction, Decomposition, Cross-Referencing) on the project brief, and build the optimal team strategy using the available workforce.

      --- LIVE DATABASE: AVAILABLE WORKFORCE ---
      ${workforceContext || "No employees currently available in the database."}
      
      --- PROJECT BRIEF ---
      "${contentToAnalyze}"
      
      CRITICAL RULES:
      1. Decompose the requested project into functional, non-functional, security, and technical requirements.
      2. Compare the required technical stack against the skills of the available workforce provided above.
      3. Shortlist the best candidates based on skill overlap and explain exactly why they fit.
      4. Generate exactly 3 to 5 highly specific technical tasks for the execution board.
      
      OUTPUT FORMAT:
      You MUST return ONLY a raw, valid JSON object. Do not include markdown formatting, backticks, or conversational text.
      Use this EXACT JSON schema:
      {
        "projectSummary": "A 4-sentence executive summary.",
        "analysisWorkflows": [ "Details on how to decompose specific features." ],
        "businessRequirements": [ "Project Vision & Goals: ..." ],
        "functionalReqs": [ "Prioritized Feature List: ..." ],
        "nonFunctionalReqs": [ "Performance Limits: ..." ],
        "securityMeasures": [ "Data Encryption Standards: ..." ],
        "technicalEnv": [ "Required Tech Stack: ..." ],
        "constraints": [ "Estimated Budget/Timeline limits: ..." ],
        "aiShortlist": [
          { "name": "Exact Name from DB", "role": "Exact Role", "reason": "Why they fit." }
        ],
        "missingSkills": ["Any requested skills nobody in the DB has"],
        "tasks": [
          { "title": "Task Name", "description": "1 sentence technical description", "complexity": "High/Medium/Low" }
        ]
      }
    `;

    console.log("🤖 Enterprise Orchestrator active. Initiating Document Analysis...");
    const parsedAnalysis = await generateJson(prompt, data =>
      typeof data.projectSummary === 'string' && Array.isArray(data.aiShortlist) &&
      data.aiShortlist.every(person => isRecord(person) && typeof person.name === 'string') &&
      Array.isArray(data.tasks) && data.tasks.length > 0 && data.tasks.every(task =>
        isRecord(task) && typeof task.title === 'string' && task.title.trim() &&
        typeof task.description === 'string' && ['High', 'Medium', 'Low'].includes(task.complexity)));
    parsedAnalysis.aiShortlist = parsedAnalysis.aiShortlist.flatMap(person => {
      const employee = availableWorkforce.find(item => item.name === person.name);
      return employee ? [{ name: employee.name, role: employee.role, reason: typeof person.reason === 'string' ? person.reason : '' }] : [];
    });
    if (!parsedAnalysis.aiShortlist.length) throw new HttpError(502, 'AI service did not select any available employees. Please try again.');

    console.log("✅ AI Orchestration Complete. JSON structured successfully.");
    
    // We return both 'tasks' (for backwards compatibility with your frontend) and the full 'analysis' object
    res.json({ 
      success: true, 
      tasks: parsedAnalysis.tasks || [], 
      analysis: parsedAnalysis 
    });

  } catch (err) {
    sendError(res, err, 'AI Orchestration engine failed to process the document.');
  }
});

module.exports = router;
