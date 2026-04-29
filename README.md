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

Optionally seed with sample data (dev only):
```bash
npm run seed
```

### 4. Start the server

```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

Server runs at `http://localhost:3000`  
Health check: `GET http://localhost:3000/health`
