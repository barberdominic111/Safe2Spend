# Safe2Spend

> "How much money can I safely spend right now?"

A privacy-focused balance tracker. No bank logins, no transaction history — just your current balances and a single number.

---

## Project Structure

```
safe2spend/
├── index.html
├── vite.config.js
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx
    ├── index.css
    └── App.jsx        ← main app (safe2spend.jsx renamed)
```

---

## Local Setup

```bash
# 1. Create the folder and copy files in
mkdir safe2spend && cd safe2spend

# 2. Install dependencies
npm install

# 3. Run locally
npm run dev
```

Open http://localhost:5173 in your browser.

---

## Deploy to Vercel

### Option A — Vercel CLI (fastest)
```bash
npm install -g vercel
vercel
```
Follow the prompts. It will give you a live URL in ~30 seconds.
On first run it asks: link to existing project? → **N**. It creates one.

### Option B — GitHub + Vercel dashboard
```bash
git init
git add .
git commit -m "init safe2spend"
gh repo create safe2spend --public --push --source=.
```
Then go to vercel.com → Add New Project → import your GitHub repo → Deploy.

---

## Test on Android

1. Open the Vercel URL in **Chrome on Android**
2. Tap the three-dot menu → **Add to Home Screen**
3. It installs as a PWA — full screen, no browser chrome

---

## Notes

- All data is in-memory only (resets on refresh). Persistent storage via localStorage or a backend is a future step.
- SMS paste works on any device. Automatic SMS reading requires Android + a native app wrapper (future V2).
- The Plaid version (direct bank connections) is a separate project — see the prompt in your Claude thread.
