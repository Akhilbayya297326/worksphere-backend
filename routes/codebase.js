const express = require('express');
const router = express.Router();
const { generateJson, sendError, requireText, isStringArray } = require('../utils/ai');

// POST: Query the Enterprise GitHub Codebase
router.post('/query', async (req, res) => {
  try {
    const query = requireText(req.body?.query, 'Codebase query', 10000);

    // 1. Simulated Vector Database of Company GitHub Repositories
    // In a live production environment, this data would be fetched from ChromaDB after 
    // embedding the company's actual GitHub repos via a CI/CD pipeline hook.
    const companyRepositoriesContext = `
      Repository: worksphere-auth-service (Backend)
      File: middleware/jwtGuard.js
      Methodology: We use strict stateless JWTs with a 15-minute expiration. Refresh tokens MUST be stored in HTTP-only cookies to prevent XSS attacks.
      Code Snippet:
      const jwtGuard = (req, res, next) => {
        const token = req.cookies.accessToken || req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Enterprise Unauthorized' });
        // validation logic...
      };

      Repository: worksphere-ui-components (Frontend)
      File: components/EnterpriseButton.jsx
      Methodology: All enterprise buttons must use the Tailwind 'bg-blue-600' class and include a Lucide icon for accessibility. We strictly use functional React components.
      Code Snippet:
      export const EnterpriseButton = ({ icon: Icon, text, onClick }) => (
        <button onClick={onClick} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-xl flex items-center transition-colors">
          {Icon && <Icon className="w-5 h-5 mr-2" />}
          {text}
        </button>
      );

      Repository: worksphere-database-schemas
      File: models/BaseSchema.js
      Methodology: All MongoDB models must include Mongoose timestamps (createdAt, updatedAt) and use strict schema validation to prevent NoSQL injection.
    `;

    // 3. Precision Prompting for Codebase Engineering
    const prompt = `
      You are the WorkSphere AI Senior Staff Engineer.
      A developer is asking a question about how to implement a feature or find existing code.
      Your job is to answer their query STRICTLY using the provided "Company GitHub Repositories Context".

      CRITICAL RULES:
      - If the answer/code is NOT in the context, do not invent code. State clearly that this pattern does not currently exist in the enterprise repositories.
      - Emphasize the company's specific "Methodology" in your explanation.
      - Return the best reusable code snippet if one exists.

      Company GitHub Repositories Context:
      ${companyRepositoriesContext}

      Developer Query: "${query}"

      JSON Schema Requirement:
      {
        "overview": "A 1-2 sentence explanation of how the company handles this requirement.",
        "companyMethodology": "An explanation of the strict internal standards or rules regarding this implementation.",
        "reusableCode": "The exact code snippet from the context they can copy/paste, or null if not applicable.",
        "sourceRepository": "The name of the repository and file this came from.",
        "actionableAdvice": ["Step 1", "Step 2"]
      }
    `;

    // 4. Generate & Parse
    const structuredCodeData = await generateJson(prompt, data =>
      typeof data.overview === 'string' && typeof data.companyMethodology === 'string' &&
      (data.reusableCode === null || typeof data.reusableCode === 'string') &&
      typeof data.sourceRepository === 'string' && isStringArray(data.actionableAdvice));

    res.json({ success: true, data: structuredCodeData, contextType: 'sample' });

  } catch (err) {
    sendError(res, err, 'Failed to query enterprise codebase.');
  }
});

module.exports = router;
