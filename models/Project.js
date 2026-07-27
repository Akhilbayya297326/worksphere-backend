const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  status: { type: String, enum: ['To Do', 'In Progress', 'Awaiting QA', 'Completed'], default: 'To Do' },
  complexity: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' }
});

const FileSchema = new mongoose.Schema({
  originalName: String,
  filename: String,
  path: String,
  mimetype: String,
  size: Number,
  uploadedBy: String,
  uploadedAt: { type: Date, default: Date.now }
});

const VaultAnalysisSchema = new mongoose.Schema({
  title: String,
  content: String,
  generatedBy: String,
  createdAt: { type: Date, default: Date.now }
});

const ProjectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  rawDocumentText: { type: String },
  
  // 🚀 NEW: Enterprise Repository Binding
  repositories: [{
    repoType: { type: String, enum: ['Frontend', 'Backend', 'Fullstack', 'Microservice', 'Other'] },
    url: { type: String }
  }],
  
  analysis: {
    businessRequirements: { vision: String, goals: [String], kpis: [String], stakeholders: [String] },
    functionalRequirements: { userPersonas: [String], featureList: [String], businessRules: [String] },
    nonFunctionalRequirements: { performance: [String], securityAndCompliance: [String], availability: [String], usability: [String] },
    technicalRequirements: { techStack: [String], infrastructure: [String], integrationPoints: [String] },
    constraintsAndDependencies: { budgetAndTimeline: [String], regulatoryLegal: [String] }
  },

  projectKnowledgeBase: {
    systemArchitecture: String,
    coreFeatures: String,
    databaseDesign: String,
    setupInstructions: String,
    qaTestingStrategy: String
  },

  aiShortlistedTeam: [{
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    name: String,
    role: String,
    reason: String
  }],
  
  allocatedTasks: [TaskSchema],
  files: [FileSchema],
  vaultAnalyses: [VaultAnalysisSchema],
  
  status: { 
    type: String, 
    enum: ['Planning', 'In Progress', 'Development', 'QA Review', 'Completed', 'Deployed'], 
    default: 'In Progress' 
  }
}, { timestamps: true });

ProjectSchema.index({ status: 1 });
ProjectSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Project', ProjectSchema);