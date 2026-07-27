const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/query', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query is required.' });
    }

    // 1. Simulated Vector Database Retrieval (ChromaDB Mock)
    const retrievedContext = `
      Document: API_Authentication_Guide.pdf (Section 3.1)
      Our authentication service uses JWT (JSON Web Tokens) for secure stateless authentication. 
      When a user logs in, the Identity Service validates the credentials and issues a signed JWT token.
      
      Document: auth-service/README.md (GitHub)
      The API Gateway validates the token before allowing access to protected services.
    `;

    // 2. Configure Gemini Model with Native JSON Structuring
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash', // Uses your exact requested model
      generationConfig: { 
        temperature: 0.1, 
        responseMimeType: 'application/json' 
      } 
    });

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

    const result = await model.generateContent(prompt);
    const structuredData = JSON.parse(result.response.text());

    res.json({ success: true, data: structuredData });

  } catch (err) {
    console.error("Knowledge Copilot Error:", err);
    res.status(500).json({ success: false, error: 'Failed to process knowledge query.' });
  }
});

module.exports = router;