# Vyas Backend

Custom Express backend for the **Vyaas Room Booking** web app at MIT WPU.

## Quick Start

**Prerequisites:** Node 20+, PostgreSQL, Redis

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your PostgreSQL credentials, Redis URL, and a 32+ character JWT secret.

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set up the database

```bash
psql -U postgres -d vyas -f database/schema.sql
```

Optionally seed the real Vyas data (dev only; refuses `NODE_ENV=production`):
```bash
npm run seed
```
This creates the Vyas building (5 floors, 53 rooms), one planner term (2026-27 odd CSE: pool rooms, rules,
faculty, divisions, batches, subjects, offerings and a draft timetable) and 4 test accounts
(`admin@mitwpu.edu.in` + 3 faculty) used by the tests. It seeds no real users, bookings, templates or
timetable-import data, is safe to re-run, and never overwrites an existing planner term. Run
`npm run db:migrate` first. The data lives in `database/seed-data/*.json`
(refresh with `node scripts/export-seed-data.mjs` against a populated DB).

### 4. Start the server

```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

Server runs at `http://localhost:3000`  
Health check: `GET http://localhost:3000/health`
