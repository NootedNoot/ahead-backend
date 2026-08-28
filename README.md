# ahead-backend — Trend Detection & Contextual Guess Engine
**Part of the Ahead Ecosystem | Node.js Express REST API**
*Last Updated: 2026-08-20*

---

## Overview
`ahead-backend` is an Express.js API server deployed on Railway (`https://ahead-backend-production-ee80.up.railway.app`). It provides server-side trend analysis, multi-step glucose projections, and physiological root-cause heuristics for the Ahead ecosystem.

*Note: For the master ecosystem architecture, complete math formulas, and hardware specifications, refer to [`../01_AHEAD_ARCHITECTURE_AND_MATH.md`](file:///c:/Users/singe/Projects/01_AHEAD_ARCHITECTURE_AND_MATH.md) and [`../02_AHEAD_ECOSYSTEM_AND_REPOS.md`](file:///c:/Users/singe/Projects/02_AHEAD_ECOSYSTEM_AND_REPOS.md).*

---

## Key Modules
* **`server.js`**: Express server setup, CORS configuration, in-memory trend caching (`/api/latest-trend`), and check endpoint (`/api/check-trend`).
* **`trend-detector.js`**: Server-authoritative 2-interval smoothed rate calculation, yellow/red proximity evaluation, and rate trajectory assessment.
* **`guess-engine.js`**: Contextual rule-based etiology engine evaluating potential causes for glycemic excursions (uncovered meals, dawn phenomenon, exercise drop, rebound/Somogyi, compression lows, interstitial lag).

---

## API Endpoints

### `POST /api/check-trend`
Evaluates an incoming array of glucose readings from a client.
* **Request Body**:
  ```json
  {
    "readings": [
      { "date": 1771600000000, "sgv": 115 },
      { "date": 1771600300000, "sgv": 110 }
    ],
    "tuning": { "yellowLow": 80, "yellowHigh": 200, "redLow": 70, "redHigh": 250 }
  }
  ```
* **Response Body**:
  ```json
  {
    "processed": [
      {
        "date": 1771600300000,
        "currentValue": 110,
        "rate": -1.0,
        "trendPhase": "falling",
        "severity": "none",
        "projected": 95,
        "projectedExtended": 80,
        "trajectory": "consistent",
        "guesses": []
      }
    ]
  }
  ```

### `GET /api/latest-trend`
Returns the most recent trend evaluation cached in server memory. Returns 404 if no readings have been processed since the last server restart.

---

## Commands & Testing

```bash
# Install dependencies
npm install

# Start local server (default port: 3000)
npm start

# Run test suite (including cross-repo golden-vector tests)
npm test
```
