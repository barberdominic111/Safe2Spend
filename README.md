# Systems2See-Money

> "How much money can I safely spend right now?"

A privacy-focused cash flow app. No bank logins required. All data stays on your device.

---

## Folder structure

```
systems2see-money/
├── index.html
├── package.json
├── vite.config.js
├── .gitignore
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx
    ├── index.css
    └── App.jsx        ← entire app lives here
```

---

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

---

## Deploy to Vercel

### Option A — push to GitHub, then connect Vercel
```bash
git init
git add .
git commit -m "systems2see-money v1.0"
gh repo create systems2see-money --public --push --source=.
```
Then go to vercel.com → Add New Project → import the repo → Deploy.

### Option B — Vercel CLI
```bash
npm install -g vercel
vercel
```

---

## Update an existing deployment

```bash
git add .
git commit -m "update"
git push
```
Vercel auto-deploys on every push to main.

---

## Use on Android

1. Open the Vercel URL in Chrome on Android
2. Three-dot menu → Add to Home Screen
3. Installs as a full-screen PWA

## Use on iOS

SMS auto-reading is not available on iOS. Use the Paste SMS panel on the Spending tab to manually paste balance alerts from your bank.

---

## Account roles

| Role | What it is |
|------|-----------|
| Spending | Your discretionary bank account(s). Safe to Spend = these minus credit cards. |
| Bills | Dedicated account for bill obligations. Shown on Bills tab scale. |
| Credit Card | Balances subtracted from Spending accounts. |
| Holding | Investment/brokerage accounts. Visible on Invest tab only. |

---

## Data & privacy

All data is stored locally in your browser via `localStorage`. Nothing is sent to any server. Vercel only serves the app files — it never sees your financial data.
