# Finly Backend

Express.js API server for the Finly personal finance application.

## Tech Stack

- Node.js 20
- Express 5
- PostgreSQL
- JWT Authentication

## Development

```bash
npm install
npm run dev
```

The server runs on `http://localhost:3001`.

## Environment Variables

See `.env.example` for required variables.

## API Endpoints

- `GET /api/health` - Health check
- `POST /api/auth/signup` - User registration
- `POST /api/auth/login` - User login
- `GET /api/transactions` - List transactions
- `POST /api/transactions` - Create transaction
- `GET /api/categories` - List categories
- `GET /api/accounts` - List accounts
- `GET /api/budgets` - List budgets
- `GET /api/savings-goals` - List savings goals
- `GET /api/stats/*` - Statistics endpoints
- `POST /api/ai/*` - AI features

## Docker

```bash
docker build -t finly-backend .
docker run -p 3001:3001 --env-file .env finly-backend
```
