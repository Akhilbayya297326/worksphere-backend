const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Employee = require('../models/Employee'); // We pull this to give the AI live DB context

// Initialize Gemini
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// POST: Elite Enterprise Document Analysis & Workforce Routing
router.post('/analyze-doc', async (req, res) => {
  try {
    const { text, documentData } = req.body;
    const contentToAnalyze = text || documentData;

    if (!contentToAnalyze) {
      return res.status(400).json({ success: false, error: 'No document text provided for analysis.' });
    }

    // 1. Fetch live workforce data to simulate the "Find Employees Tool"
    const availableWorkforce = await Employee.find({ availability: 'Available' }).select('name role skills experienceYears');
    const workforceContext = availableWorkforce.map(emp => 
      `Name: ${emp.name}, Role: ${emp.role}, Skills: ${emp.skills.join(', ')}`
    ).join('\n');

    // 2. Fallback for testing if Gemini API key isn't set yet
    if (!genAI) {
      console.warn("⚠️ GEMINI_API_KEY not found. Using presentation mock data.");
      return res.json({
        success: true,
        analysis: {
          projectSummary: "Mock analysis due to missing API key.",
          tasks: [{ title: 'System Architecture', description: 'Design DB schema', complexity: 'High' }]
        }
      });
    }

    // 3. Real Gemini AI Orchestration (Deep Document Analysis)
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash', // Lightning fast for JSON parsing
      generationConfig: { temperature: 0.1 } // Low temperature for high precision/logic
    });
    
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
    const result = await model.generateContent(prompt);
    
    // 4. Bulletproof JSON Parsing
    let responseText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
    
    let parsedAnalysis;
    try {
      parsedAnalysis = JSON.parse(responseText);
    } catch (parseError) {
      console.error("AI JSON Formatting Error. Attempting regex extraction...", parseError);
      return res.status(500).json({ success: false, error: 'AI Orchestrator failed to format output correctly.' });
    }

    console.log("✅ AI Orchestration Complete. JSON structured successfully.");
    
    // We return both 'tasks' (for backwards compatibility with your frontend) and the full 'analysis' object
    res.json({ 
      success: true, 
      tasks: parsedAnalysis.tasks || [], 
      analysis: parsedAnalysis 
    });

  } catch (err) {
    console.error("AI Analysis Error:", err);
    res.status(500).json({ success: false, error: 'AI Orchestration engine failed to process the document.' });
  }
});

module.exports = router;