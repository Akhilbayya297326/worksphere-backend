const mongoose = require('mongoose');
require('dotenv').config();
const Employee = require('./models/Employee');

const dummyEmployees = [
  // --- MANAGERS ---
  {
    name: 'Bayya Akhil',
    email: 'admin@worksphere.com',
    password: 'cisco2026',
    role: 'Manager',
    skills: ['Agile Methodology', 'Team Leadership', 'AI Orchestration'],
    technologiesKnown: ['Jira', 'Confluence', 'MERN Stack'],
    certifications: ['Scrum Master Certified', 'AWS Cloud Practitioner'],
    experienceYears: 6,
    previousProjects: ['Enterprise AI Rollout', 'Cloud Migration'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Exceptional leadership during the AI integration phase.' }]
  },
  {
    name: 'Sarah Connor',
    email: 'sarah@worksphere.com',
    password: 'cisco2026',
    role: 'Manager',
    skills: ['Product Management', 'Resource Allocation'],
    technologiesKnown: ['Jira', 'Trello', 'Tableau'],
    certifications: ['PMP'],
    experienceYears: 8,
    previousProjects: ['E-Commerce Revamp'],
    availability: 'Busy',
    performanceHistory: [{ rating: 4, review: 'Strong delivery, working on improving technical depth.' }]
  },

  // --- DEVELOPERS ---
  {
    name: 'Arjun Sharma',
    email: 'arjun@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Frontend Architecture', 'State Management', 'UI/UX Implementation'],
    technologiesKnown: ['React', 'Node.js', 'AWS', 'Tailwind CSS'],
    certifications: ['AWS Certified Developer'],
    experienceYears: 5.2,
    previousProjects: ['Payment Integration Dashboard', 'Admin Portal'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Consistently writes clean, modular React components.' }]
  },
  {
    name: 'Priya Patel',
    email: 'priya@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Full Stack Development', 'API Design', 'Database Optimization'],
    technologiesKnown: ['Java', 'Spring Boot', 'SQL', 'React'],
    certifications: ['Oracle Certified Professional'],
    experienceYears: 4.1,
    previousProjects: ['Inventory Management System'],
    availability: 'Available',
    performanceHistory: [{ rating: 4, review: 'Excellent backend logic, improving frontend speed.' }]
  },
  {
    name: 'Rahul Verma',
    email: 'rahul@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Backend Architecture', 'Data Pipelines', 'Microservices'],
    technologiesKnown: ['Python', 'Django', 'PostgreSQL', 'Docker'],
    certifications: ['GCP Professional Data Engineer'],
    experienceYears: 3.6,
    previousProjects: ['User Analytics Engine'],
    availability: 'Busy',
    performanceHistory: [{ rating: 4, review: 'Solid Python developer, handles complex data structures well.' }]
  },
  {
    name: 'Sneha Kapoor',
    email: 'sneha@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Responsive Design', 'Component Testing'],
    technologiesKnown: ['React', 'TypeScript', 'Tailwind CSS', 'Jest'],
    certifications: ['Meta Front-End Developer'],
    experienceYears: 2.8,
    previousProjects: ['Customer Support Chatbot UI'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Great eye for design and strict adherence to Figma files.' }]
  },
  {
    name: 'Karan Mehta',
    email: 'karan@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Web Fundamentals', 'Bug Fixing'],
    technologiesKnown: ['JavaScript', 'HTML', 'CSS', 'Express'],
    certifications: ['FreeCodeCamp JavaScript Algorithms'],
    experienceYears: 1.2,
    previousProjects: ['Internal Tooling Scripts'],
    availability: 'Available',
    performanceHistory: [{ rating: 3, review: 'Eager to learn, needs more experience with modern frameworks.' }]
  },
  {
    name: 'David Chen',
    email: 'david@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['DevOps', 'CI/CD Pipelines', 'Cloud Infrastructure'],
    technologiesKnown: ['Kubernetes', 'Docker', 'Jenkins', 'AWS'],
    certifications: ['AWS Solutions Architect'],
    experienceYears: 6,
    previousProjects: ['Zero-Trust Security Pipeline'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Instrumental in reducing deployment times by 40%.' }]
  },
  {
    name: 'Maria Garcia',
    email: 'maria@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['AI Integration', 'Machine Learning', 'NLP'],
    technologiesKnown: ['Python', 'TensorFlow', 'LangChain', 'MongoDB'],
    certifications: ['DeepLearning.AI Specialization'],
    experienceYears: 4,
    previousProjects: ['Sentiment Analysis Module'],
    availability: 'On Leave',
    performanceHistory: [{ rating: 5, review: 'Pioneered our initial LLM integration tests.' }]
  },
  {
    name: 'James Wilson',
    email: 'james@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['System Security', 'Cryptography', 'Backend'],
    technologiesKnown: ['C++', 'Rust', 'Node.js'],
    certifications: ['CompTIA Security+'],
    experienceYears: 7,
    previousProjects: ['Auth Gateway Overhaul'],
    availability: 'Available',
    performanceHistory: [{ rating: 4, review: 'Highly secure code, sometimes over-engineers solutions.' }]
  },
  {
    name: 'Linda Martinez',
    email: 'linda@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Mobile Development', 'Cross-Platform UI'],
    technologiesKnown: ['React Native', 'Swift', 'Firebase'],
    certifications: ['Google Associate Android Developer'],
    experienceYears: 3,
    previousProjects: ['Mobile HR App'],
    availability: 'Available',
    performanceHistory: [{ rating: 4, review: 'Fast delivery on mobile features.' }]
  },
  {
    name: 'Ahmed Syed',
    email: 'ahmed@worksphere.com',
    password: 'cisco2026',
    role: 'Developer',
    skills: ['Database Administration', 'Query Optimization'],
    technologiesKnown: ['MongoDB', 'Redis', 'GraphQL'],
    certifications: ['MongoDB Developer'],
    experienceYears: 5,
    previousProjects: ['Data Migration 2025'],
    availability: 'Busy',
    performanceHistory: [{ rating: 5, review: 'Saved us thousands in database costs through optimization.' }]
  },

  // --- QA TESTERS ---
  {
    name: 'Emily Davis',
    email: 'emily@worksphere.com',
    password: 'cisco2026',
    role: 'QA Tester',
    skills: ['Automated Testing', 'E2E Testing', 'Load Testing'],
    technologiesKnown: ['Selenium', 'Cypress', 'JMeter'],
    certifications: ['ISTQB Certified Tester'],
    experienceYears: 4.5,
    previousProjects: ['Payment Gateway Load Test'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Catches critical edge cases before production.' }]
  },
  {
    name: 'Michael Brown',
    email: 'michael@worksphere.com',
    password: 'cisco2026',
    role: 'QA Tester',
    skills: ['Manual Testing', 'API Testing', 'Bug Tracking'],
    technologiesKnown: ['Postman', 'Jira', 'Swagger'],
    certifications: [],
    experienceYears: 2,
    previousProjects: ['User Onboarding Flow QA'],
    availability: 'Available',
    performanceHistory: [{ rating: 4, review: 'Thorough and highly communicative with developers.' }]
  },
  {
    name: 'Sophie Martin',
    email: 'sophie@worksphere.com',
    password: 'cisco2026',
    role: 'QA Tester',
    skills: ['Security Testing', 'Penetration Testing'],
    technologiesKnown: ['OWASP ZAP', 'Burp Suite', 'Python'],
    certifications: ['Certified Ethical Hacker (CEH)'],
    experienceYears: 5,
    previousProjects: ['Annual Security Audit'],
    availability: 'Available',
    performanceHistory: [{ rating: 5, review: 'Found and patched three critical vulnerabilities this year.' }]
  },
  {
    name: 'Daniel Kim',
    email: 'daniel@worksphere.com',
    password: 'cisco2026',
    role: 'QA Tester',
    skills: ['Performance Testing', 'Mobile QA'],
    technologiesKnown: ['Appium', 'BrowserStack'],
    certifications: ['Mobile Testing Professional'],
    experienceYears: 3,
    previousProjects: ['Mobile App Launch QA'],
    availability: 'Busy',
    performanceHistory: [{ rating: 4, review: 'Reliable mobile tester across various device viewports.' }]
  }
  
];

const seedDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB.');

    // Clear existing talent data
    await Employee.deleteMany();
    console.log('🗑️  Cleared existing employee data.');

    // Insert the 16 dummy employees
    await Employee.insertMany(dummyEmployees);
    console.log('🌱 Successfully seeded 16 employee profiles into the registry.');

    process.exit();
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
};

seedDatabase();