const express = require('express');
const router = express.Router();
const { generateJson, sendError, requireText, isStringArray } = require('../utils/ai');

router.post('/query', async (req, res) => {
  try {
    const query = requireText(req.body?.query, 'Query', 10000);

    // 1. Simulated Vector Database Retrieval (ChromaDB Mock)
    const retrievedContext = `
      Document: API_Authentication_Guide.pdf (Section 3.1)
      Our authentication service uses JWT (JSON Web Tokens) for secure stateless authentication. 
      When a user logs in, the Identity Service validates the credentials and issues a signed JWT token.
      
      Document: auth-service/README.md (GitHub)
      The API Gateway validates the token before allowing access to protected services.
    `;

    const prompt = `
      You are the WorkSphere AI Enterprise Knowledge Copilot.
      Your primary directive is to answer the user's question STRICTLY using the provided "Enterprise Context".
      
      CRITICAL RULES:
      - If the answer is NOT present, set "overview" to "I cannot find this in the enterprise knowledge base."
      - Do not rely on your general training data. Use ONLY the provided context.
      - Ensure the output strictly matches the requested JSON schema.

      Enterprise Context:
      ${retrievedContext}

      User Question: "${query}"

      JSON Schema Requirement:
      {
        "overview": "A clear, 2-sentence summary grounded ONLY in the context.",
        "keyPoints": ["Point 1", "Point 2"],
        "technicalDetails": "Detailed technical explanation based on context, otherwise an empty string.",
        "actionItems": ["Action 1"],
        "sources": ["List the document names referenced in the context"],
        "confidenceScore": "A percentage string (e.g., '98%') representing confidence based on context match"
      }
    `;

    const structuredData = await generateJson(prompt, data =>
      typeof data.overview === 'string' && typeof data.technicalDetails === 'string' &&
      isStringArray(data.keyPoints) && isStringArray(data.actionItems) && isStringArray(data.sources) &&
      typeof data.confidenceScore === 'string');

    res.json({ success: true, data: structuredData, contextType: 'sample' });

  } catch (err) {
    sendError(res, err, 'Failed to process knowledge query.');
  }
});

module.exports = router;
