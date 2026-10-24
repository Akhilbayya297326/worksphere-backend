const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const { generateJson, HttpError, sendError, isRecord, isStringArray, requireText } = require('../utils/ai');

const { requireManager } = require('../middleware/auth');

router.param('id', (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
  }
  next();
});

function normalizeSkills(value, label = 'Skills') {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!isStringArray(items)) throw new HttpError(400, `${label} must be a string array or comma-separated string.`);
  return [...new Set(items.map(skill => skill.trim()).filter(Boolean))];
}

function employeeError(res, error, fallback) {
  if (error.code === 11000) return res.status(409).json({ success: false, error: 'An employee with that email already exists.' });
  return sendError(res, error, fallback);
}

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
router.post('/add', requireManager, async (req, res) => {
  try {
    const { name, role, skills, email, department } = req.body || {};
    const skillArray = normalizeSkills(skills);

    const newEmployee = new Employee({
      name: requireText(name, 'Name', 200),
      email: requireText(email, 'Email', 320),
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
    employeeError(res, err, 'Failed to add employee.');
  }
});

// PUT: Edit Employee Details
router.put('/:id', requireManager, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
    }

    if (!isRecord(req.body)) throw new HttpError(400, 'Employee details must be an object.');
    const allowedFields = ['name', 'email', 'role', 'department', 'availability', 'skills', 'technologiesKnown', 'certifications', 'experienceYears', 'previousProjects', 'performanceHistory', 'aiSuggestedSkills'];
    const update = Object.fromEntries(allowedFields.filter(field => Object.hasOwn(req.body, field)).map(field => [field, req.body[field]]));
    for (const field of ['skills', 'technologiesKnown', 'certifications', 'previousProjects', 'aiSuggestedSkills']) {
      if (Object.hasOwn(update, field)) update[field] = normalizeSkills(update[field], field);
    }
    for (const field of ['name', 'email']) {
      if (Object.hasOwn(update, field)) update[field] = requireText(update[field], field, 320);
    }
    if (!Object.keys(update).length) throw new HttpError(400, 'No editable employee fields provided.');
    const updatedEmployee = await Employee.findByIdAndUpdate(
      req.params.id, 
      { $set: update },
      { new: true, runValidators: true }
    );
    
    if (!updatedEmployee) return res.status(404).json({ success: false, error: 'Employee not found.' });
    
    res.json({ success: true, employee: updatedEmployee });
  } catch (err) {
    employeeError(res, err, 'Failed to update employee.');
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
    employeeError(res, err, 'Failed to delete employee.');
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

    const roadmapData = await generateJson(prompt, value => typeof value.executiveSummary === 'string'
      && isStringArray(value.strengths) && isStringArray(value.areasForImprovement)
      && Array.isArray(value.actionPlan) && value.actionPlan.every(step => isRecord(step)
        && typeof step.phase === 'string' && typeof step.action === 'string'), { temperature: 0.3 });

    res.json({ success: true, roadmap: roadmapData });
  } catch (err) {
    sendError(res, err, 'Failed to generate career roadmap.');
  }
});

// POST: Gemini AI Skill Gap Analysis
router.post('/:id/suggest-skills', requireManager, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });

    const prompt = `Act as an Enterprise HR Tech AI. Analyze this developer's profile and suggest exactly 3 high-impact technologies they should learn to support their current stack and increase their value to the company.
      Role: ${employee.role}
      Experience: ${employee.experienceYears ?? 'Unknown'} years
      Current Skills: ${(employee.skills || []).join(', ')}
      Technologies Known: ${(employee.technologiesKnown || []).join(', ')}
      
      CRITICAL INSTRUCTION: Respond ONLY with a JSON object containing exactly 3 technologies.
      Example format: {"suggestions": ["Docker", "Kubernetes", "GraphQL"]}`;

    const data = await generateJson(prompt, value => isStringArray(value.suggestions)
      && value.suggestions.length === 3 && value.suggestions.every(skill => skill.trim())
      && new Set(value.suggestions.map(skill => skill.trim())).size === 3, { temperature: 0.4 });
    const suggestions = normalizeSkills(data.suggestions);

    // Update the employee in the database
    employee.aiSuggestedSkills = suggestions;
    await employee.save();

    res.json({ success: true, suggestions, employee });
  } catch (err) {
    sendError(res, err, 'AI Analysis failed.');
  }
});

module.exports = router;
