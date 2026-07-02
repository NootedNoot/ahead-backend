AHEAD - CGM Insights Tool
Patent Pending

====================
OVERVIEW
====================

Ahead is a proactive Continuous Glucose Monitor (CGM) insights tool designed for Type 1 diabetics. 
It combines a backend API server with a GitHub Pages dashboard to provide real-time glucose data 
analysis and actionable recommendations.

====================
COMPONENTS
====================

BACKEND SERVER (this repository):
- Express.js REST API server
- Integrates with Google Gemini AI API for intelligent glucose analysis
- Provides actionable insights based on glucose readings and trends
- Runs on configurable port (default: 3000)
- CORS-enabled for dashboard communication

DASHBOARD (ahead-dashboard repository):
- GitHub Pages hosted frontend
- Displays real-time CGM data
- Communicates with this backend via REST API
- User-friendly interface for glucose management insights

====================
GETTING STARTED
====================

Prerequisites:
- Node.js installed
- GEMINI_API_KEY environment variable set (Google AI API key)
- Railway or similar hosting platform (for production deployment)

Installation:
1. Clone this repository
2. Run: npm install
3. Set environment variable: GEMINI_API_KEY=<your_api_key>
4. Run: npm start (or node server.js)

====================
API ENDPOINTS
====================

GET /
  - Health check endpoint
  - Returns: "Ahead backend is running."

POST /analyze
  - Analyzes glucose readings and provides insights
  - Request body:
    {
      "readings": [
        { "time": "HH:MM", "sgv": number, "direction": string, "delta": number },
        ...
      ],
      "latest": {
        "sgv": number,
        "direction": string,
        "delta": number
      }
    }
  - Response: { "text": "AI-generated insight and options" }

====================
CONFIGURATION
====================

Environment Variables:
- PORT: Server port (default: 3000)
- GEMINI_API_KEY: Google Generative AI API key (required)

IMPORTANT: Never commit GEMINI_API_KEY to code. Set it in your hosting platform's environment settings.

====================
IMPORTANT DISCLAIMER
====================

Ahead is an informational tool ONLY. It is NOT a substitute for medical advice.
The system explicitly does NOT provide dosing recommendations.
Always consult with a healthcare provider for medical decisions.

====================
LICENSE & PATENT
====================

Patent Pending - Ahead T1d Labs

This project and its technology are protected by pending patent applications.
Unauthorized reproduction, distribution, or commercial use is prohibited.

====================
SUPPORT
====================

For issues, suggestions, or contributions, please refer to the project repository.

====================
