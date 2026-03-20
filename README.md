<h1 align="center">⚙️ Finly Backend</h1>

<p align="center">
  <strong>🔐 Secure REST API powering the Finly personal finance application</strong>
</p>

<p align="center">
  <a href="https://api.nidhiflow.in/api/health">🌐 API Health</a> •
  <a href="https://github.com/nidhiflow/finly-frontend">🖥️ Frontend Repo</a> •
  <a href="https://github.com/nidhiflow/finly-db">🗄️ Database Repo</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/License-Private-red" />
</p>

---

## 📖 About

This is the **backend API server** for Finly — a personal finance management application. It provides RESTful APIs for managing transactions, categories, accounts, budgets, savings goals, and AI-powered financial insights.

---

## ✨ Features

- 🔐 **JWT Authentication** — Secure signup, login, OTP verification, device tracking
- 💸 **Transactions** — Full CRUD with filtering, search, recurring transactions
- 📂 **Categories** — Hierarchical expense/income categories with defaults
- 🏦 **Accounts** — Multiple account types (cash, bank, credit card) with sub-accounts
- 💰 **Budgets** — Monthly budget tracking per category
- 🎯 **Savings Goals** — Goal tracking with account linking
- 🤖 **AI Assistant** — Groq-powered financial chat, budget suggestions, receipt scanning
- 📊 **Statistics** — Spending trends, category breakdowns, monthly comparisons
- 📧 **Email Notifications** — OTP, budget alerts via Brevo
- ☁️ **Google Drive Backup** — OAuth2 integration for cloud backups
- 📸 **Photo Upload** — Receipt/document upload via Cloudinary
- 🔖 **Bookmarks** — Save important transactions

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js 20** | Runtime environment |
| **Express 5** | Web framework |
| **PostgreSQL** | Primary database (hosted on Neon) |
| **JWT** | Authentication & authorization |
| **Groq AI** | AI-powered financial insights |
| **Brevo** | Transactional email service |
| **Cloudinary** | Image/file upload & storage |
| **Google APIs** | Drive backup integration |
| **bcrypt.js** | Password hashing |
| **uuid** | Unique ID generation |

---

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (or Neon account)

### Installation

```bash
git clone https://github.com/nidhiflow/finly-backend.git
cd finly-backend
npm install
```

### Environment Setup

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

### Development

```bash
npm run dev
```

The server starts at `http://localhost:3001` with auto-reload on file changes.

### Production

```bash
npm start
```

---

## 🔧 Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `3001`) |
| `NODE_ENV` | Environment (`development` / `production`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret key for JWT token signing |
| `GROQ_API_KEY` | Groq API key for AI features |
| `BREVO_API_KEY` | Brevo API key for emails |
| `BREVO_SENDER_EMAIL` | Sender email address |
| `BREVO_SENDER_NAME` | Sender display name |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `RENDER_EXTERNAL_URL` | Public URL of the backend service |

---

## 📡 API Endpoints

### 🔓 Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/signup` | User registration |
| `POST` | `/api/auth/login` | User login |
| `POST` | `/api/auth/verify-otp` | Verify OTP code |
| `POST` | `/api/auth/forgot-password` | Password reset request |
| `GET` | `/api/gdrive/callback` | Google OAuth callback |

### 🔒 Authenticated (require JWT token)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/POST` | `/api/transactions` | List / create transactions |
| `PUT/DELETE` | `/api/transactions/:id` | Update / delete transaction |
| `GET/POST` | `/api/categories` | List / create categories |
| `GET/POST` | `/api/accounts` | List / create accounts |
| `GET/POST` | `/api/budgets` | List / create budgets |
| `GET/POST` | `/api/savings-goals` | List / create savings goals |
| `GET` | `/api/stats/*` | Statistics & analytics |
| `POST` | `/api/ai/chat` | AI financial assistant |
| `POST` | `/api/ai/budget-suggestions` | AI budget suggestions |
| `POST` | `/api/ai/scan-receipt` | AI receipt scanning |
| `GET/POST` | `/api/settings` | User settings |
| `GET/POST` | `/api/bookmarks` | Transaction bookmarks |
| `GET/POST` | `/api/gdrive/*` | Google Drive backup |

---

## 🐳 Docker

```bash
# Build
docker build -t finly-backend .

# Run
docker run -p 3001:3001 --env-file .env finly-backend
```

The Docker image uses a multi-stage build with a non-root user for security.

---

## 🔄 CI/CD Pipeline

Every push to `main` triggers the GitHub Actions pipeline:

```
📦 Build → Install deps, lint, test, Docker image → Push to GHCR
🔍 Test  → Trivy (vulnerability scan), SonarQube (code quality), OWASP ZAP (DAST)
🚀 Deploy → Render pulls latest image from GHCR (only after Build + Test pass)
```

---

## 📁 Project Structure

```
finly-backend/
├── middleware/
│   └── auth.js              # JWT authentication middleware
├── routes/
│   ├── accounts.js          # Account management
│   ├── ai.js                # AI features (chat, budget, receipt)
│   ├── auth.js              # Authentication (signup, login, OTP)
│   ├── bookmarks.js         # Transaction bookmarks
│   ├── budgets.js           # Budget management
│   ├── categories.js        # Category management
│   ├── gdrive.js            # Google Drive backup
│   ├── savingsGoals.js      # Savings goal tracking
│   ├── settings.js          # User settings
│   ├── stats.js             # Statistics & analytics
│   └── transactions.js      # Transaction CRUD
├── services/
│   ├── cloudinary.js        # Image upload service
│   └── email.js             # Email service (Brevo)
├── db.js                    # Database connection & schema
├── defaultCategories.js     # Default category data
├── server.js                # Express app entry point
├── Dockerfile               # Docker build config
└── package.json
```

---

## 🏗️ Architecture

This backend is part of the **Finly microservices architecture**:

| Service | Repository | Description |
|---------|------------|-------------|
| **Frontend** | [`finly-frontend`](https://github.com/nidhiflow/finly-frontend) | React SPA |
| **Backend** | [`finly-backend`](https://github.com/nidhiflow/finly-backend) | Express.js REST API (this repo) |
| **Database** | [`finly-db`](https://github.com/nidhiflow/finly-db) | PostgreSQL schema & migrations |

### External Services

| Service | Purpose |
|---------|---------|
| **Neon** | Managed PostgreSQL database |
| **Cloudinary** | Image storage & CDN |
| **Brevo** | Transactional emails |
| **Groq** | AI language model |
| **Google APIs** | Drive backup & OAuth |

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/nidhiflow">NidhiFlow</a>
</p>
