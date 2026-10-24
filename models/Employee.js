const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true, select: false }, // Explicitly selected only by authentication
  role: { type: String, enum: ['Manager', 'Developer', 'QA Tester', 'Frontend Developer', 'Backend Developer', 'Full Stack Developer', 'DevOps Engineer'], default: 'Developer' },
  skills: [{ type: String }],
  technologiesKnown: [{ type: String }],
  certifications: [{ type: String }],
  experienceYears: { type: Number, default: 0, min: 0 },
  previousProjects: [{ type: String }],
  
  // UI mapping adjustments
  department: { type: String, default: 'Engineering' }, 
  availability: { type: String, enum: ['Available', 'Busy', 'On Leave'], default: 'Available' },
  
  performanceHistory: [{
    rating: Number,
    review: String,
    date: { type: Date, default: Date.now }
  }],
  aiSuggestedSkills: [{ type: String }] // The WOW factor field
}, { timestamps: true });

EmployeeSchema.set('toJSON', {
  transform: (_doc, value) => {
    delete value.password;
    return value;
  }
});

module.exports = mongoose.model('Employee', EmployeeSchema);
