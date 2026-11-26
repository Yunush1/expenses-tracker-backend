# Expense Tracker Backend

This package contains the server-side application for the shared-expense platform.

## Responsibilities

- Express API server
- MongoDB-backed domain models
- Redis-backed rate limiting and shared state
- Firebase push configuration
- realtime collaboration via Socket.IO
- background jobs and scheduled tasks
- AI, referral, monetization, and expense-domain logic

## Key entry points

- `server.js` — server startup and lifecycle
- `src/app.js` — app middleware and security posture
- `src/routes/index.js` — route structure and access boundaries
- `src/config/env.js` — environment validation and config parsing

## Run locally

```bash
npm install
npm run dev
```

## Useful scripts

- `npm test` — run the backend test suite
- `npm run start` — production server
- `npm run ai:check` — AI feature checks
- `npm run mirror:check` — mirror validations
- `npm run date:check` — date validation checks

## Notes

The repository already contains substantial in-code documentation and architecture notes, but it did not have a project-level README. This file is intended as the starting point for onboarding and maintenance.

For the higher-level system overview, see the root workspace docs in [../docs/architecture.md](../docs/architecture.md) and [../docs/development.md](../docs/development.md).
