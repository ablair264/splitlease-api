# Splitlease API

Express.js backend for the Splitlease vehicle leasing broker platform.

## Tech Stack

- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL (Neon) + Drizzle ORM
- **Auth**: JWT (NextAuth compatible)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment file:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`

4. Run development server:
```bash
npm run dev
```

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to dist/
- `npm start` - Run production build

## API Routes

### Public
- `GET /health` - Health check
- `GET /api/vehicles` - Vehicle listing with filters
- `GET /api/rates` - Rate search
- `GET /api/rates/best` - Best deals per vehicle
- `POST /api/leads` - Create lead

### Protected (requires auth)
- `GET /api/leads` - List leads
- `GET /api/admin/dashboard/stats` - Dashboard KPIs
- `GET /api/admin/deals` - Deal finder
- `GET /api/admin/ratebooks` - Import history
- `GET /api/admin/rates` - Rate explorer

## Deployment

Deployed on Railway with auto-deploy from this repository.

Server URL: `https://splitfin-broker-production.up.railway.app`
