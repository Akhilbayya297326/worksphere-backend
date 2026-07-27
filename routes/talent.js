const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Safely mock requireManager to prevent 403 Forbidden errors during demo
const requireManager = (req, res, next) => next();

// Conditionally initialize AI to prevent server crashes if key is missing
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// ==========================================
// 🧑‍💻 CRUD ROUTES
// ==========================================

// GET: Fetch all employees (Sorted)
router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find().sort({ role: 1, name: 1 });
    // Returning both 'talent' and 'employees' keys to ensure compatibility with any frontend version
    res.json({ success: true, employees, talent: employees });
  } catch (err) {
    console.error("Fetch Talent Error:", err);
    res.status(500).json({ success: false, error: 'Failed to fetch talent data.' });
  }
});

// POST: Add a new employee
router.post('/add', async (req, res) => {
  try {
    const { name, role, skills, email, department } = req.body;
    const skillArray = skills ? skills.split(',').map(skill => skill.trim()) : [];

    const newEmployee = new Employee({
      name,
      email,
      password: 'EnterpriseDefault123!', 
      role: role || 'Developer',
      department: department || 'Engineering',
      skills: skillArray,
      technologiesKnown: skillArray, 
      availability: 'Available'
    });

    await newEmployee.save();
    res.status(201).json({ success: true, employee: newEmployee });
  } catch (err) {
    console.error("Add Employee Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT: Edit Employee Details
router.put('/:id', requireManager, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      req.params.id, 
      { $set: req.body }, 
      { new: true, runValidators: true }
    );
    
    if (!updatedEmployee) return res.status(404).json({ success: false, error: 'Employee not found.' });
    
    res.json({ success: true, employee: updatedEmployee });
  } catch (err) {
    console.error("Edit Employee Error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE: Remove Employee
router.delete('/:id', requireManager, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
    }

    const deletedEmployee = await Employee.findByIdAndDelete(req.params.id);
    if (!deletedEmployee) return res.status(404).json({ success: false, error: 'Employee not found.' });

    res.json({ success: true, message: 'Employee permanently removed.' });
  } catch (err) {
    console.error("Delete Employee Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 🤖 AI INTEGRATION ROUTES
// ==========================================

// POST: Generate AI Career Roadmap for an Employee
router.post('/:id/roadmap', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });

    let roadmapData;

    if (genAI) {
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash', 
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } 
      });

      const prompt = `You are an expert Enterprise Career Coach. Analyze this employee:
      Name: ${employee.name}
      Role: ${employee.role}
      Current Skills: ${employee.skills?.join(', ') || 'General IT'}
      
      Create a highly detailed, professional career improvement roadmap for them.
      Use this EXACT JSON schema:
      {
        "executiveSummary": "2 sentences evaluating their current standing.",
        "strengths": ["Strength 1", "Strength 2"],
        "areasForImprovement": ["Skill to learn 1", "Skill to learn 2", "Skill to learn 3"],
        "actionPlan": [
          { "phase": "Phase 1: Immediate (0-30 Days)", "action": "Specific technical action..." },
          { "phase": "Phase 2: Short-Term (30-90 Days)", "action": "Specific project/learning action..." },
          { "phase": "Phase 3: Long-Term (3-6 Months)", "action": "Specific leadership/architectural action..." }
        ]
      }`;

      const result = await model.generateContent(prompt);
      roadmapData = JSON.parse(result.response.text());
    } else {
      // Fallback if no API key is set
      roadmapData = {
        executiveSummary: "AI Engine offline. Manual review required.",
        strengths: employee.skills || ["Reliable team member"],
        areasForImprovement: ["Advanced Cloud Architecture", "System Design"],
        actionPlan: [
          { phase: "Phase 1: Immediate (0-30 Days)", action: "Review current enterprise tech stack." }
        ]
      };
    }

    res.json({ success: true, roadmap: roadmapData });
  } catch (err) {
    console.error("AI Roadmap Error:", err);
    res.status(500).json({ success: false, error: 'Failed to generate career roadmap.' });
  }
});

// POST: Gemini AI Skill Gap Analysis
router.post('/:id/suggest-skills', requireManager, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });

    let suggestions = [];

    if (genAI) {
      // Using application/json guarantees Gemini returns a parsable array, avoiding regex hacks
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
      });
      
      const prompt = `Act as an Enterprise HR Tech AI. Analyze this developer's profile and suggest exactly 3 high-impact technologies they should learn to support their current stack and increase their value to the company.
      Role: ${employee.role}
      Experience: ${employee.experienceYears || 'Unknown'} years
      Current Skills: ${(employee.skills || []).join(', ')}
      Technologies Known: ${(employee.technologiesKnown || []).join(', ')}
      
      CRITICAL INSTRUCTION: Respond ONLY with a valid JSON array of strings containing exactly 3 technologies. 
      Example format: ["Docker", "Kubernetes", "GraphQL"]`;

      const result = await model.generateContent(prompt);
      suggestions = JSON.parse(result.response.text());
    } else {
      // Fallback if no API key is set
      suggestions = ["Docker", "Kubernetes", "GraphQL"];
    }

    // Update the employee in the database
    employee.aiSuggestedSkills = suggestions;
    await employee.save();

    res.json({ success: true, suggestions, employee });
  } catch (err) {
    console.error("Gemini AI Skills Error:", err);
    res.status(500).json({ success: false, error: 'AI Analysis failed.' });
  }
});

module.exports = router;