import { useState, useRef } from "react";

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(n) {
  const abs = Math.abs(n);
  return (n < 0 ? "-" : "") + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShort(n) {
  if (n === null) return "—";
  const abs = Math.abs(n);
  return (n < 0 ? "-" : "") + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function nowISO() { return new Date().toISOString(); }
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
const SOURCES = { manual: "Manual", sms: "SMS", api: "API" };

// ─── SMS Parsing ──────────────────────────────────────────────────────────────

// Patterns that yield a last4 digit string directly
const SMS_PATTERNS = [
  // PNC actual format: "PNC credit card x1234 balance as of MM/DD/YY is $X"
  { regex: /x(\d{4})\s+balance\s+as\s+of\s+[\d/]+\s+is\s+\$([0-9,]+\.\d{2})/i, label: "PNC" },
  // PNC fallback: anything with x1234 ... is $X
  { regex: /x(\d{4})[^$]*is\s+\$([0-9,]+\.\d{2})/i, label: "PNC" },
  // PNC old style: "account ending in x1234 ... $X"
  { regex: /account\s+ending\s+in\s+x+(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "PNC" },
  // Citi style: "acct ending in 1234 has a balance of $X"
  { regex: /acct\s+ending\s+in\s+(\d{4})[^$]*balance\s+of\s+\$([0-9,]+\.\d{2})/i, label: "Citi" },
  // Citi fallback: "acct ending in 1234 ... $X"
  { regex: /acct\s+ending\s+in\s+(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "Citi" },
  // Generic "account ending in 1234 ... $X" or "account ending 1234 ... $X"
  { regex: /account\s+ending\s+(?:in\s+)?(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "Bank" },
  // Chase/generic: "Acct *1234 balance: $X"
  { regex: /Acct\s*\*?(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "Chase" },
  // Capital One: "Your balance is $X for account ending in 1234"
  { regex: /balance\s+is\s+\$([0-9,]+\.\d{2})\s+for\s+account\s+ending\s+in\s+(\d{4})/i, label: "Capital One", flip: true },
  // Generic: "balance of $X ... 1234" (Citi fallback, others)
  { regex: /balance\s+of\s+\$([0-9,]+\.\d{2})[^0-9]*(\d{4})/i, label: "Bank", flip: true },
  // Generic account *1234
  { regex: /account\s*\*?(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "Bank" },
  // Broad fallback: any x1234 ... $X pattern
  { regex: /x(\d{4})[^$]*\$([0-9,]+\.\d{2})/i, label: "Bank" },
];

// Card-name patterns — no last4 digits in the message; returns { cardName, balance }
const CARD_NAME_PATTERNS = [
  // "Chase Sapphire Reserve Visa: Your balance of $296.93 ..."
  // "Chase Freedom Unlimited: Your balance of $X ..."
  { regex: /(Chase\s+[A-Za-z ]+?)(?:Visa|Mastercard)?:\s*Your\s+balance\s+of\s+\$([0-9,]+\.\d{2})/i, label: "Chase" },
  // Generic: "CardName: ... balance of $X" or "CardName: ... balance: $X"
  { regex: /^([A-Za-z ]+?):\s*.*balance\s+(?:of|is)?:?\s*\$([0-9,]+\.\d{2})/im, label: "Card" },
];

// Returns:
//   { type: "digits",   accountLast4, balance, label }   — known account, save immediately
//   { type: "cardname", cardName,     balance, label }   — no digits, needs account confirmation
//   null — unrecognised
function parseSMS(text) {
  // Try digit-bearing patterns first
  for (const p of SMS_PATTERNS) {
    const m = text.match(p.regex);
    if (m) {
      const last4  = p.flip ? m[2] : m[1];
      const balStr = p.flip ? m[1] : m[2];
      const balance = parseFloat(balStr.replace(/,/g, ""));
      if (!isNaN(balance) && last4.length === 4)
        return { type: "digits", accountLast4: last4, balance, label: p.label };
    }
  }
  // Try card-name patterns (no digits)
  for (const p of CARD_NAME_PATTERNS) {
    const m = text.match(p.regex);
    if (m) {
      const cardName = m[1].trim();
      const balance  = parseFloat(m[2].replace(/,/g, ""));
      if (!isNaN(balance) && cardName.length > 1)
        return { type: "cardname", cardName, balance, label: p.label };
    }
  }
  return null;
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

function isDuplicate(snapshots, last4, balance, source) {
  const TWO_MIN = 2 * 60 * 1000;
  return snapshots.some(s =>
    s.accountLast4 === last4 && s.balance === balance && s.source === source &&
    Math.abs(new Date(s.timestamp) - new Date()) < TWO_MIN
  );
}

// ─── Account Roles ────────────────────────────────────────────────────────────
// role: "income" | "spending"
// incomeRank: 0 = Primary, 1 = Secondary, 2 = Tertiary, etc. (null for spending)
// incomeLabel: custom label e.g. "Primary", "Secondary", "Backup"

const RANK_NAMES = ["Primary", "Secondary", "Tertiary", "Quaternary"];
function rankName(r) { return RANK_NAMES[r] ?? `#${r + 1}`; }

// ─── Waterfall Safe-to-Spend ──────────────────────────────────────────────────
// Spending obligations are subtracted from income accounts in rank order.
// Returns { safeToSpend, accountAmounts: { [last4]: amountUsed } }

function computeWaterfall(accounts, latestBalance) {
  const incomeAccts = accounts
    .filter(a => a.role === "income")
    .sort((a, b) => a.incomeRank - b.incomeRank);
  const spendingAccts = accounts.filter(a => a.role === "spending");

  const spendingTotal = spendingAccts.reduce((s, a) => s + (latestBalance(a.last4) ?? 0), 0);

  if (!incomeAccts.length) return { safeToSpend: null, residuals: {} };

  // Distribute obligation across income accounts in order
  let remaining = spendingTotal;
  const residuals = {}; // how much of each income account is "free"
  for (const acct of incomeAccts) {
    const bal = latestBalance(acct.last4) ?? 0;
    if (remaining <= 0) {
      residuals[acct.last4] = bal; // fully available
    } else if (bal >= remaining) {
      residuals[acct.last4] = bal - remaining;
      remaining = 0;
    } else {
      residuals[acct.last4] = 0;
      remaining -= bal;
    }
  }

  const safeToSpend = incomeAccts.reduce((s, a) => s + residuals[a.last4], 0) - Math.max(0, remaining);
  return { safeToSpend, residuals };
}

// ─── Threshold Color ──────────────────────────────────────────────────────────
// mode: "dollar" | "percent"
// For percent mode, startingBalance is the first-ever recorded balance for that account

function bandColor(value, thresholds, mode, startingBalance) {
  if (value === null) return "#4A6280";
  const { hi, mid, lo } = thresholds;
  const hiN  = parseFloat(hi);
  const midN = parseFloat(mid);
  const loN  = parseFloat(lo);
  if (isNaN(hiN) || isNaN(midN) || isNaN(loN)) return value >= 0 ? "#00D4AA" : "#FF6B6B";

  let compare = value;
  if (mode === "percent" && startingBalance && startingBalance > 0) {
    compare = (value / startingBalance) * 100;
  }
  if (compare >= hiN)  return "#00D4AA";
  if (compare >= midN) return "#F5C842";
  if (compare >= loN)  return "#F5A623";
  return "#FF6B6B";
}

// ─── Due Date Helpers ────────────────────────────────────────────────────────

// Returns days until due for a fixed day-of-month (handles month wrap)
function daysUntilDue(dayOfMonth) {
  if (!dayOfMonth) return null;
  const today = new Date();
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), dayOfMonth);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, dayOfMonth);
  const target = thisMonth >= today ? thisMonth : nextMonth;
  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

// Returns the next due date as a short string e.g. "Jul 15"
function nextDueDateStr(dayOfMonth) {
  if (!dayOfMonth) return null;
  const today = new Date();
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), dayOfMonth);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, dayOfMonth);
  const target = thisMonth >= today ? thisMonth : nextMonth;
  return target.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Returns color based on days until due and user thresholds
function dueColor(daysLeft, dt) {
  if (daysLeft === null) return null;
  const g = parseInt(dt.green);
  const y = parseInt(dt.yellow);
  const r = parseInt(dt.red);
  if (daysLeft >= g)  return "#00D4AA";
  if (daysLeft >= y)  return "#F5C842";
  if (daysLeft >= r)  return "#F5A623";
  return "#FF6B6B";
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ─── Defaults (used only on first launch) ────────────────────────────────────

const DEFAULT_ACCOUNTS       = [];
const DEFAULT_SNAPSHOTS      = [];
const DEFAULT_THRESHOLDS     = { hi: "60", mid: "30", lo: "15" };
const DEFAULT_THRESHOLD_MODE = "percent"; // "dollar" | "percent"
const DEFAULT_DUE_THRESHOLDS = { green: "14", yellow: "7", red: "3" }; // days until due

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Space+Grotesk:wght@400;600;700&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:#0A1628; color:#E8EEF6; font-family:'DM Sans',sans-serif; -webkit-font-smoothing:antialiased; overscroll-behavior:none; }
  .app { max-width:430px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; background:#0A1628; }
  .screen { flex:1; padding:0 0 96px; overflow-y:auto; }

  /* header */
  .header { padding:52px 24px 20px; display:flex; justify-content:space-between; align-items:flex-end; }
  .header-label { font-size:11px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#4A6280; }
  .header-date  { font-size:13px; color:#4A6280; }

  /* hero */
  .hero { padding:8px 24px 28px; text-align:center; }
  .hero-eyebrow { font-size:11px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:#4A6280; margin-bottom:12px; }
  .hero-amount  { font-family:'Space Grotesk',monospace; font-size:72px; font-weight:700; line-height:1; letter-spacing:-2px; transition:color 0.6s ease; }
  .hero-amount.anim { animation:breathe 1.6s ease-out forwards; }
  @keyframes breathe { 0%{opacity:0;transform:scale(.96)} 60%{opacity:1;transform:scale(1.01)} 100%{opacity:1;transform:scale(1)} }
  .hero-sub { margin-top:10px; font-size:13px; color:#4A6280; }

  /* waterfall strip — shows each income account's share of the total */
  .waterfall-strip { margin:0 24px 28px; display:flex; gap:3px; height:5px; border-radius:3px; overflow:hidden; }
  .waterfall-seg   { border-radius:3px; transition:flex 0.5s ease, background 0.5s ease; min-width:3px; }

  .divider { height:1px; background:#1A2E4A; margin:0 24px 24px; }
  .section-label { font-size:10px; font-weight:600; letter-spacing:2.5px; text-transform:uppercase; color:#2E4A6A; padding:0 24px; margin-bottom:10px; }

  /* account cards */
  .account-list { padding:0 16px; margin-bottom:28px; display:flex; flex-direction:column; gap:8px; }
  .account-card { background:#111E33; border-radius:14px; padding:16px 18px; display:flex; justify-content:space-between; align-items:center; border:1px solid #1A2E4A; }
  .account-card.rank-0 { border-color:#00D4AA28; background:#0D1F35; }
  .account-card.due    { border-left-width:3px !important; padding-left:15px !important; }
  .account-card.rank-1 { border-color:#7B68EE28; background:#0E1D35; }
  .account-card-left { display:flex; align-items:center; gap:12px; }
  .acct-rank-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .account-label   { font-size:14px; font-weight:500; color:#C8D8E8; }
  .account-last4   { font-size:12px; color:#4A6280; margin-top:2px; }
  .account-balance { font-family:'Space Grotesk',monospace; font-size:17px; font-weight:600; color:#E8EEF6; text-align:right; }
  .account-balance.no-data { color:#2E4A6A; font-size:14px; }
  .rank-badge { font-size:10px; font-weight:600; letter-spacing:.5px; padding:2px 7px; border-radius:10px; margin-top:3px; display:inline-block; }

  /* sms panel */
  .sms-panel { margin:0 16px 28px; background:#0D1F35; border:1px dashed #1A3A5A; border-radius:14px; padding:18px; }
  .sms-panel-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#9B88FF; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
  .sms-textarea { width:100%; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:13px; padding:12px; resize:none; outline:none; min-height:80px; transition:border-color .2s; }
  .sms-textarea:focus { border-color:#9B88FF; }
  .sms-textarea::placeholder { color:#2E4A6A; }
  .sms-parse-btn { width:100%; margin-top:10px; background:#9B88FF; color:#fff; border:none; border-radius:10px; padding:12px; font-family:'DM Sans',sans-serif; font-size:14px; font-weight:600; cursor:pointer; }
  .sms-parse-btn:active { opacity:.85; }
  .sms-result { margin-top:10px; font-size:13px; padding:10px 12px; border-radius:8px; }
  .sms-result.success { background:#00D4AA12; color:#00D4AA; }
  .sms-result.error   { background:#FF6B6B12; color:#FF6B6B; }
  .sms-result .select-input { margin-bottom:0; font-size:13px; padding:9px 11px; }

  /* manual entry */
  .manual-panel { margin:0 16px 28px; background:#0D1F35; border:1px dashed #1A3A5A; border-radius:14px; padding:18px; }
  .manual-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#F5A623; margin-bottom:12px; }
  .select-input { width:100%; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:14px; padding:11px 13px; outline:none; margin-bottom:10px; appearance:none; cursor:pointer; }
  .select-input:focus { border-color:#F5A623; }

  /* history */
  .history-list  { padding:0 16px; display:flex; flex-direction:column; gap:8px; }
  .history-item  { background:#111E33; border:1px solid #1A2E4A; border-radius:12px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; }
  .history-time    { font-size:11px; color:#4A6280; margin-top:2px; }
  .history-account { font-size:14px; font-weight:500; color:#C8D8E8; }
  .history-source  { font-size:10px; padding:2px 7px; border-radius:10px; margin-top:4px; display:inline-block; }
  .src-manual { background:#F5A62320; color:#F5A623; }
  .src-sms    { background:#9B88FF20; color:#9B88FF; }
  .src-api    { background:#00D4AA20; color:#00D4AA; }
  .history-balance { font-family:'Space Grotesk',monospace; font-size:18px; font-weight:600; color:#E8EEF6; text-align:right; }
  .history-empty   { text-align:center; color:#2E4A6A; padding:48px 24px; font-size:14px; line-height:1.6; }

  /* settings */
  .settings-section { padding:0 16px; margin-bottom:28px; }
  .settings-row { background:#111E33; border:1px solid #1A2E4A; border-radius:12px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .settings-row-label { font-size:14px; color:#C8D8E8; }
  .settings-row-sub   { font-size:12px; color:#4A6280; margin-top:2px; }
  .pill { font-size:11px; padding:4px 10px; border-radius:20px; font-weight:600; cursor:pointer; border:none; font-family:'DM Sans',sans-serif; }
  .pill-green  { background:#00D4AA20; color:#00D4AA; }
  .pill-teal   { background:#00D4AA; color:#0A1628; }
  .pill-red    { background:#FF6B6B18; color:#FF6B6B; }
  .pill-purple { background:#9B88FF20; color:#9B88FF; }
  .pill-up     { background:#1A2E4A; color:#C8D8E8; }
  .pill-down   { background:#1A2E4A; color:#C8D8E8; }

  /* add account form */
  .add-form { background:#0D1F35; border:1px dashed #1A3A5A; border-radius:14px; padding:18px; margin:0 16px 24px; }
  .add-form-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#F5A623; margin-bottom:12px; }
  .input-row { display:flex; gap:10px; }
  .text-input { flex:1; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:14px; padding:11px 13px; outline:none; transition:border-color .2s; min-width:0; }
  .text-input:focus { border-color:#F5A623; }
  .text-input::placeholder { color:#2E4A6A; }
  .add-btn { background:#F5A623; color:#0A1628; border:none; border-radius:10px; padding:11px 18px; font-family:'DM Sans',sans-serif; font-size:14px; font-weight:700; cursor:pointer; white-space:nowrap; }
  .add-btn:active { opacity:.85; }
  .role-toggle { display:flex; gap:8px; margin-bottom:10px; }
  .role-btn { flex:1; padding:9px; border-radius:10px; border:1px solid #1A2E4A; background:#0A1628; color:#4A6280; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; }
  .role-btn.active { background:#1A2E4A; color:#E8EEF6; border-color:#2E4A6A; }

  /* threshold panel */
  .threshold-panel { background:#0D1F35; border:1px solid #1A3A5A; border-radius:14px; padding:18px; margin:0 16px 24px; }
  .threshold-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#4A6280; margin-bottom:4px; }
  .threshold-hint  { font-size:12px; color:#2E4A6A; margin-bottom:14px; line-height:1.5; }
  .mode-toggle { display:flex; gap:6px; margin-bottom:14px; }
  .mode-btn { flex:1; padding:8px; border-radius:10px; border:1px solid #1A2E4A; background:#0A1628; color:#4A6280; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; text-align:center; }
  .mode-btn.active { background:#1A2E4A; color:#E8EEF6; border-color:#2E4A6A; }
  .band-preview { display:flex; height:4px; border-radius:2px; overflow:hidden; margin-bottom:14px; gap:2px; }
  .band-seg { flex:1; border-radius:2px; }
  .threshold-row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
  .threshold-swatch { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
  .threshold-input { flex:1; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:14px; padding:10px 13px; outline:none; transition:border-color .2s; min-width:0; }
  .threshold-input:focus { border-color:#4A6280; }
  .threshold-input::placeholder { color:#2E4A6A; }
  .threshold-unit { font-size:13px; color:#4A6280; min-width:16px; }
  .threshold-save { width:100%; margin-top:6px; background:#1A2E4A; color:#C8D8E8; border:none; border-radius:10px; padding:11px; font-family:'DM Sans',sans-serif; font-size:14px; font-weight:600; cursor:pointer; }
  .threshold-save:hover { background:#243E5A; }

  /* nav */
  .nav { position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:430px; background:#0D1929; border-top:1px solid #1A2E4A; display:flex; padding:12px 0 28px; z-index:100; }
  .nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; background:none; border:none; cursor:pointer; padding:6px 0; }
  .nav-icon { width:22px; height:22px; }
  .nav-label { font-family:'DM Sans',sans-serif; font-size:10px; font-weight:500; letter-spacing:1px; text-transform:uppercase; transition:color .15s; }
  .nav-btn.active .nav-label { color:#00D4AA; }
  .nav-btn        .nav-label { color:#2E4A6A; }
  .nav-btn.active .nav-icon path,
  .nav-btn.active .nav-icon rect,
  .nav-btn.active .nav-icon circle { stroke:#00D4AA !important; }
  .nav-btn        .nav-icon path,
  .nav-btn        .nav-icon rect,
  .nav-btn        .nav-icon circle { stroke:#2E4A6A; transition:stroke .15s; }

  /* toast */
  .toast { position:fixed; top:20px; left:50%; transform:translateX(-50%); background:#00D4AA; color:#0A1628; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:600; padding:10px 20px; border-radius:24px; z-index:999; animation:toastIn .25s ease, toastOut .3s ease 2s forwards; pointer-events:none; white-space:nowrap; }
  @keyframes toastIn  { from{opacity:0;transform:translateX(-50%) translateY(-8px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  @keyframes toastOut { from{opacity:1} to{opacity:0} }

  .screen-title { font-size:20px; font-weight:600; color:#E8EEF6; padding:52px 24px 24px; font-family:'Space Grotesk',sans-serif; }
`;

// ─── Rank dot colors ──────────────────────────────────────────────────────────

const RANK_COLORS = ["#00D4AA", "#9B88FF", "#F5C842", "#F5A623"];
function rankColor(r) { return RANK_COLORS[r % RANK_COLORS.length]; }

// ─── Icons ────────────────────────────────────────────────────────────────────

const IconHome = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/>
  </svg>
);
const IconHistory = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
  </svg>
);
const IconSettings = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

// ─── HomeScreen ───────────────────────────────────────────────────────────────

function HomeScreen({ accounts, snapshots, safeToSpend, residuals, thresholds,
                      thresholdMode, heroKey, smsText, setSmsText, smsResult,
                      onParseSMS, onConfirmCard, manualAcct, setManualAcct, manualBal,
                      setManualBal, onManualSave, latestBalance, firstBalance, dueThresholds }) {

  const incomeAccts  = accounts.filter(a => a.role === "income").sort((a,b) => a.incomeRank - b.incomeRank);
  const spendingAccts = accounts.filter(a => a.role === "spending");
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });

  // Hero color: based on Primary account's residual vs its starting balance
  const primaryAcct = incomeAccts[0];
  const primaryResidual = primaryAcct ? (residuals[primaryAcct.last4] ?? null) : null;
  const primaryStart = primaryAcct ? firstBalance(primaryAcct.last4) : null;
  const heroCol = bandColor(safeToSpend, thresholds, thresholdMode, primaryStart);

  // Waterfall strip: each income account shown proportionally by current balance
  const totalIncome = incomeAccts.reduce((s,a) => s + (latestBalance(a.last4) ?? 0), 0);

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Safe2Spend</div>
        <div className="header-date">{today}</div>
      </div>

      <div className="hero">
        <div className="hero-eyebrow">Safe to spend</div>
        <div key={heroKey} className="hero-amount anim" style={{ color: heroCol }}>
          {fmtShort(safeToSpend)}
        </div>
        <div className="hero-sub">
          {safeToSpend === null ? "Add income account balances to get started"
           : safeToSpend >= 0  ? "Available after obligations"
           : "Obligations exceed available balance"}
        </div>
      </div>

      {/* Waterfall strip */}
      {incomeAccts.length > 0 && totalIncome > 0 && (
        <div className="waterfall-strip">
          {incomeAccts.map(a => {
            const bal = latestBalance(a.last4) ?? 0;
            const start = firstBalance(a.last4);
            const res = residuals[a.last4] ?? 0;
            const col = bandColor(res, thresholds, thresholdMode, start);
            return (
              <div key={a.last4} className="waterfall-seg"
                style={{ flex: bal, background: col, opacity: 0.85 }} />
            );
          })}
        </div>
      )}

      <div className="divider" />

      {/* Income accounts */}
      {incomeAccts.length > 0 && <>
        <div className="section-label">Income Accounts</div>
        <div className="account-list">
          {incomeAccts.map(a => {
            const bal = latestBalance(a.last4);
            const res = residuals[a.last4] ?? null;
            const start = firstBalance(a.last4);
            const col = bandColor(res, thresholds, thresholdMode, start);
            return (
              <div className={`account-card rank-${a.incomeRank}`} key={a.last4}>
                <div className="account-card-left">
                  <div className="acct-rank-dot" style={{ background: rankColor(a.incomeRank) }} />
                  <div>
                    <div className="account-label">{a.label}</div>
                    <div className="account-last4">•••• {a.last4}</div>
                    <span className="rank-badge" style={{ background: rankColor(a.incomeRank) + "20", color: rankColor(a.incomeRank) }}>
                      {rankName(a.incomeRank)}
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {bal !== null
                    ? <div className="account-balance" style={{ color: col }}>{fmt(bal)}</div>
                    : <div className="account-balance no-data">No balance</div>}
                  {res !== null && bal !== null && (
                    <div style={{ fontSize: 11, color: "#4A6280", marginTop: 3 }}>
                      {fmt(res)} free
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </>}

      {/* Spending accounts */}
      {spendingAccts.length > 0 && <>
        <div className="section-label">Spending Accounts</div>
        <div className="account-list">
          {spendingAccts.map(a => {
            const b = latestBalance(a.last4);
            const days = daysUntilDue(a.dueDay);
            const dateStr = nextDueDateStr(a.dueDay);
            const dc = dueColor(days, dueThresholds);
            return (
              <div className="account-card" key={a.last4}
                style={{ borderLeft: dc ? `3px solid ${dc}` : "1px solid #1A2E4A",
                         paddingLeft: dc ? 15 : 17 }}>
                <div className="account-card-left">
                  <div>
                    <div className="account-label">{a.label}</div>
                    <div className="account-last4">•••• {a.last4}</div>
                    {dateStr && (
                      <span className="rank-badge" style={{
                        background: dc ? dc + "20" : "#1A2E4A",
                        color: dc ?? "#4A6280",
                        marginTop: 4,
                      }}>
                        Due {dateStr}
                        {days !== null && ` · ${days}d`}
                      </span>
                    )}
                    {!dateStr && (
                      <span className="rank-badge" style={{ background:"#1A2E4A", color:"#2E4A6A" }}>
                        No due date
                      </span>
                    )}
                  </div>
                </div>
                {b !== null
                  ? <div className="account-balance">{fmt(b)}</div>
                  : <div className="account-balance no-data">No balance</div>}
              </div>
            );
          })}
        </div>
      </>}

      {/* SMS */}
      <div className="section-label">Paste SMS Alert</div>
      <div className="sms-panel">
        <div className="sms-panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9B88FF" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          Bank SMS
        </div>
        <textarea className="sms-textarea"
          placeholder={"Paste a balance alert, e.g.:\nAcct *1234 balance: $4,000.00"}
          value={smsText} onChange={e => setSmsText(e.target.value)} />
        <button className="sms-parse-btn" onClick={onParseSMS}>Parse & Save Balance</button>
        {smsResult && smsResult.ok === "confirm" ? (
          <div className="sms-result" style={{ background:"#9B88FF14", color:"#C8D8E8" }}>
            <div style={{ marginBottom:10 }}>{smsResult.msg}</div>
            <select className="select-input" style={{ marginBottom:8 }}
              defaultValue=""
              onChange={e => e.target.value && onConfirmCard(e.target.value, smsResult.balance)}>
              <option value="" disabled>Select account…</option>
              {accounts.map(a => (
                <option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>
              ))}
            </select>
          </div>
        ) : smsResult ? (
          <div className={`sms-result ${smsResult.ok ? "success" : "error"}`}>{smsResult.msg}</div>
        ) : null}
      </div>

      {/* Manual */}
      <div className="section-label">Manual Entry</div>
      <div className="manual-panel">
        <div className="manual-title">Enter Balance Manually</div>
        <select className="select-input" value={manualAcct} onChange={e => setManualAcct(e.target.value)}>
          <option value="">Select account…</option>
          {accounts.map(a => (
            <option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>
          ))}
        </select>
        <div className="input-row">
          <input className="text-input" placeholder="0.00" value={manualBal}
            onChange={e => setManualBal(e.target.value)} type="number" inputMode="decimal" />
          <button className="add-btn" onClick={onManualSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── HistoryScreen ────────────────────────────────────────────────────────────

function HistoryScreen({ snapshots, accounts }) {
  const sorted = [...snapshots].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  return (
    <div className="screen">
      <div className="screen-title">Balance History</div>
      {sorted.length === 0
        ? <div className="history-empty">No history yet.<br/>Paste an SMS or enter a balance manually.</div>
        : <div className="history-list">
            {sorted.map(s => {
              const acct = accounts.find(a => a.last4 === s.accountLast4);
              return (
                <div className="history-item" key={s.id}>
                  <div>
                    <div className="history-account">{acct ? acct.label : "Acct"} •{s.accountLast4}</div>
                    <div className="history-time">{fmtTime(s.timestamp)}</div>
                    <span className={`history-source src-${s.source}`}>{SOURCES[s.source]}</span>
                  </div>
                  <div className="history-balance">{fmt(s.balance)}</div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// ─── SettingsScreen ───────────────────────────────────────────────────────────

function SettingsScreen({ accounts, thresholds, thresholdMode,
                          onSetRole, onReorder, onRemoveAccount,
                          onAddAccount, onSaveThresholds, onSaveThresholdMode,
                          dueThresholds, onSaveDueThresholds, onSetDueDay }) {
  const [newLabel, setNewLabel] = useState("");
  const [newLast4, setNewLast4] = useState("");
  const [newRole,  setNewRole]  = useState("income");

  const [tHi,  setTHi]  = useState(thresholds.hi);
  const [tMid, setTMid] = useState(thresholds.mid);
  const [tLo,  setTLo]  = useState(thresholds.lo);
  const [tMode, setTMode] = useState(thresholdMode);
  const [dGreen,  setDGreen]  = useState(dueThresholds.green);
  const [dYellow, setDYellow] = useState(dueThresholds.yellow);
  const [dRed,    setDRed]    = useState(dueThresholds.red);

  const incomeAccts  = accounts.filter(a => a.role === "income").sort((a,b) => a.incomeRank - b.incomeRank);
  const spendingAccts = accounts.filter(a => a.role === "spending");

  function handleAdd() {
    const l4 = newLast4.replace(/\D/g,"").slice(-4);
    if (l4.length !== 4 || !newLabel.trim()) return;
    onAddAccount(l4, newLabel.trim(), newRole);
    setNewLabel(""); setNewLast4("");
  }

  function handleSave() {
    onSaveThresholds({ hi: tHi, mid: tMid, lo: tLo });
    onSaveThresholdMode(tMode);
    onSaveDueThresholds({ green: dGreen, yellow: dYellow, red: dRed });
  }

  const unit = tMode === "percent" ? "%" : "$";
  const placeholder = tMode === "percent"
    ? ["e.g. 60", "e.g. 30", "e.g. 15"]
    : ["e.g. 2000", "e.g. 1000", "e.g. 500"];

  return (
    <div className="screen">
      <div className="screen-title">Settings</div>

      {/* ── Color Bands ── */}
      <div className="section-label">Color Bands</div>
      <div className="threshold-panel">
        <div className="threshold-title">Spending Levels</div>
        <div className="threshold-hint">
          The hero number changes color as your safe-to-spend crosses each level. Dollar or percent of each income account's opening balance.
        </div>
        <div className="mode-toggle">
          <button className={`mode-btn ${tMode === "dollar"  ? "active" : ""}`} onClick={() => setTMode("dollar")}>$ Dollar</button>
          <button className={`mode-btn ${tMode === "percent" ? "active" : ""}`} onClick={() => setTMode("percent")}>% Percent</button>
        </div>
        <div className="band-preview">
          {["#00D4AA","#F5C842","#F5A623","#FF6B6B"].map(c => <div key={c} className="band-seg" style={{ background: c }} />)}
        </div>
        {[
          { color:"#00D4AA", label:"Above this →", val:tHi, set:setTHi, ph:placeholder[0] },
          { color:"#F5C842", label:"Above this →", val:tMid, set:setTMid, ph:placeholder[1] },
          { color:"#F5A623", label:"Above this →", val:tLo, set:setTLo, ph:placeholder[2] },
        ].map(({ color, val, set, ph }) => (
          <div className="threshold-row" key={color}>
            <div className="threshold-swatch" style={{ background: color }} />
            <input className="threshold-input" placeholder={ph} value={val}
              onChange={e => set(e.target.value)} type="number" inputMode="decimal" />
            <span className="threshold-unit">{unit}</span>
          </div>
        ))}
        <div style={{ fontSize:11, color:"#2E4A6A", marginBottom:12, paddingLeft:22 }}>Below the last level shows red.</div>
        <button className="threshold-save" onClick={handleSave}>Save levels</button>
      </div>

      {/* ── Due Date Thresholds ── */}
      <div className="section-label">Payment Due Colors</div>
      <div className="threshold-panel">
        <div className="threshold-title">Days Until Due</div>
        <div className="threshold-hint">
          Each card shows a color strip and badge based on how many days until its bill is due.
        </div>
        <div className="band-preview">
          {["#00D4AA","#F5C842","#F5A623","#FF6B6B"].map(c => <div key={c} className="band-seg" style={{ background:c }} />)}
        </div>
        {[
          { color:"#00D4AA", val:dGreen,  set:setDGreen,  ph:"e.g. 14" },
          { color:"#F5C842", val:dYellow, set:setDYellow, ph:"e.g. 7"  },
          { color:"#F5A623", val:dRed,    set:setDRed,    ph:"e.g. 3"  },
        ].map(({ color, val, set, ph }) => (
          <div className="threshold-row" key={color}>
            <div className="threshold-swatch" style={{ background:color }} />
            <input className="threshold-input" placeholder={ph} value={val}
              onChange={e => set(e.target.value)} type="number" inputMode="numeric" />
            <span className="threshold-unit">days</span>
          </div>
        ))}
        <div style={{ fontSize:11, color:"#2E4A6A", marginBottom:12, paddingLeft:22 }}>
          Below the last level shows red. Changes save with the "Save levels" button above.
        </div>
      </div>

      {/* ── Income Accounts (ordered) ── */}
      <div className="section-label">Income Accounts</div>
      <div className="settings-section">
        {incomeAccts.length === 0 && (
          <div className="settings-row"><div className="settings-row-sub">No income accounts yet.</div></div>
        )}
        {incomeAccts.map((a, i) => (
          <div className="settings-row" key={a.last4}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:rankColor(a.incomeRank), flexShrink:0 }} />
              <div>
                <div className="settings-row-label">{a.label}</div>
                <div className="settings-row-sub">•••• {a.last4} · {rankName(a.incomeRank)}</div>
              </div>
            </div>
            <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", justifyContent:"flex-end" }}>
              {i > 0 && (
                <button className="pill pill-up" onClick={() => onReorder(a.last4, "up")}>↑</button>
              )}
              {i < incomeAccts.length - 1 && (
                <button className="pill pill-down" onClick={() => onReorder(a.last4, "down")}>↓</button>
              )}
              <button className="pill pill-purple" onClick={() => onSetRole(a.last4, "spending")}>→ Spending</button>
              <button className="pill pill-red" onClick={() => onRemoveAccount(a.last4)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Spending Accounts ── */}
      <div className="section-label">Spending Accounts</div>
      <div className="settings-section">
        {spendingAccts.length === 0 && (
          <div className="settings-row"><div className="settings-row-sub">No spending accounts yet.</div></div>
        )}
        {spendingAccts.map(a => (
          <div className="settings-row" key={a.last4} style={{ flexDirection:"column", alignItems:"stretch", gap:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:"#F5A623", flexShrink:0 }} />
                <div>
                  <div className="settings-row-label">{a.label}</div>
                  <div className="settings-row-sub">•••• {a.last4}</div>
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button className="pill pill-teal" onClick={() => onSetRole(a.last4, "income")}>→ Income</button>
                <button className="pill pill-red"  onClick={() => onRemoveAccount(a.last4)}>Remove</button>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10, paddingLeft:18 }}>
              <span style={{ fontSize:12, color:"#4A6280", whiteSpace:"nowrap" }}>Due day</span>
              <input
                className="text-input"
                style={{ maxWidth:80, padding:"7px 10px", fontSize:13 }}
                placeholder="e.g. 15"
                type="number"
                inputMode="numeric"
                min="1" max="31"
                defaultValue={a.dueDay ?? ""}
                key={a.last4 + "_due"}
                onBlur={e => onSetDueDay(a.last4, e.target.value || null)}
              />
              <span style={{ fontSize:12, color:"#2E4A6A" }}>of each month</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Add Account ── */}
      <div className="section-label">Add Account</div>
      <div className="add-form">
        <div className="add-form-title">New Account</div>
        <div className="role-toggle">
          <button className={`role-btn ${newRole === "income"  ? "active" : ""}`} onClick={() => setNewRole("income")}>Income</button>
          <button className={`role-btn ${newRole === "spending"? "active" : ""}`} onClick={() => setNewRole("spending")}>Spending</button>
        </div>
        <div className="input-row" style={{ marginBottom:10 }}>
          <input className="text-input" placeholder="Label (e.g. Chase Checking)"
            value={newLabel} onChange={e => setNewLabel(e.target.value)} />
        </div>
        <div className="input-row">
          <input className="text-input" placeholder="Last 4 digits" value={newLast4}
            maxLength={4} onChange={e => setNewLast4(e.target.value)} inputMode="numeric" />
          <button className="add-btn" onClick={handleAdd}>Add</button>
        </div>
      </div>

      <div className="section-label">About</div>
      <div className="settings-section">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Safe2Spend</div>
            <div className="settings-row-sub">v0.4 · Waterfall · $ or % · Due date colors</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab]               = useState("home");
  const [accounts, setAccounts]     = useState(() => load("s2s_accounts",      DEFAULT_ACCOUNTS));
  const [snapshots, setSnapshots]   = useState(() => load("s2s_snapshots",     DEFAULT_SNAPSHOTS));
  const [thresholds, setThresholds] = useState(() => load("s2s_thresholds",    DEFAULT_THRESHOLDS));
  const [thresholdMode, setThresholdMode] = useState(() => load("s2s_tmode",   DEFAULT_THRESHOLD_MODE));
  const [dueThresholds, setDueThresholds] = useState(() => load("s2s_due_thr", DEFAULT_DUE_THRESHOLDS));
  const [heroKey, setHeroKey]       = useState(0);
  const [smsText, setSmsText]       = useState("");
  const [smsResult, setSmsResult]   = useState(null);
  const [manualAcct, setManualAcct] = useState("");
  const [manualBal, setManualBal]   = useState("");
  const [toast, setToast]           = useState(null);
  const toastRef = useRef();

  // Persist to localStorage via wrapper setters below
  function setAccountsP(v)      { const val = typeof v === "function" ? v(accounts)  : v; save("s2s_accounts",   val); setAccounts(val);      }
  function setSnapshotsP(v)     { const val = typeof v === "function" ? v(snapshots) : v; save("s2s_snapshots",  val); setSnapshots(val);     }
  function setThresholdsP(v)    { const val = typeof v === "function" ? v(thresholds): v; save("s2s_thresholds", val); setThresholds(val);    }
  function setThresholdModeP(v) { const val = typeof v === "function" ? v(thresholdMode):v; save("s2s_tmode",   val); setThresholdMode(val); }
  function setDueThresholdsP(v) { const val = typeof v === "function" ? v(dueThresholds):v; save("s2s_due_thr", val); setDueThresholds(val); }

  function showToast(msg) {
    setToast(null);
    setTimeout(() => setToast(msg), 10);
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 2400);
  }

  function latestBalance(last4) {
    const snaps = snapshots.filter(s => s.accountLast4 === last4);
    if (!snaps.length) return null;
    return snaps.reduce((a,b) => new Date(a.timestamp) > new Date(b.timestamp) ? a : b).balance;
  }

  // First-ever recorded balance for an account (used as "starting balance" for % mode)
  function firstBalance(last4) {
    const snaps = snapshots.filter(s => s.accountLast4 === last4);
    if (!snaps.length) return null;
    return snaps.reduce((a,b) => new Date(a.timestamp) < new Date(b.timestamp) ? a : b).balance;
  }

  const { safeToSpend, residuals } = computeWaterfall(accounts, latestBalance);

  function ingestBalance(last4, balance, source) {
    if (isDuplicate(snapshots, last4, balance, source)) return false;
    setSnapshotsP(prev => [{ id: Date.now(), accountLast4: last4, balance, timestamp: nowISO(), source }, ...prev]);
    setHeroKey(k => k + 1);
    return true;
  }

  function handleParseSMS() {
    const result = parseSMS(smsText.trim());
    if (!result) { setSmsResult({ ok:false, msg:"Couldn't parse a balance. Check the format." }); return; }

    if (result.type === "cardname") {
      // No digits found — ask user to pick which account this card maps to
      setSmsResult({
        ok: "confirm",
        cardName: result.cardName,
        balance: result.balance,
        msg: `Found "${result.cardName}" — ${fmt(result.balance)}. Which account is this?`,
      });
      return;
    }

    // Normal digits path
    if (!accounts.find(a => a.last4 === result.accountLast4)) {
      const nextRank = accounts.filter(a => a.role === "income").length;
      setAccountsP(prev => [...prev, { last4: result.accountLast4, label: result.label + " •" + result.accountLast4, role: "income", incomeRank: nextRank }]);
    }
    if (!ingestBalance(result.accountLast4, result.balance, "sms")) {
      setSmsResult({ ok:false, msg:"Duplicate — same balance within 2 minutes." }); return;
    }
    setSmsResult({ ok:true, msg:`Saved: •${result.accountLast4} → ${fmt(result.balance)}` });
    setSmsText("");
    showToast("Balance updated");
  }

  function handleConfirmCardAccount(last4, balance) {
    if (!ingestBalance(last4, balance, "sms")) {
      setSmsResult({ ok:false, msg:"Duplicate — same balance within 2 minutes." }); return;
    }
    setSmsResult({ ok:true, msg:`Saved: •${last4} → ${fmt(balance)}` });
    setSmsText("");
    showToast("Balance updated");
  }

  function handleManualSave() {
    const bal = parseFloat(String(manualBal).replace(/[^0-9.]/g,""));
    if (!manualAcct || isNaN(bal)) return;
    ingestBalance(manualAcct, bal, "manual");
    setManualBal("");
    showToast("Balance saved");
  }

  function handleSetRole(last4, newRole) {
    setAccountsP(prev => {
      const updated = prev.map(a => {
        if (a.last4 !== last4) return a;
        if (newRole === "income") {
          const maxRank = Math.max(-1, ...prev.filter(x => x.role === "income" && x.last4 !== last4).map(x => x.incomeRank));
          return { ...a, role: "income", incomeRank: maxRank + 1 };
        }
        return { ...a, role: "spending", incomeRank: null };
      });
      return rerank(updated);
    });
    setHeroKey(k => k + 1);
    showToast("Account role updated");
  }

  function rerank(accts) {
    const income = accts.filter(a => a.role === "income").sort((a,b) => (a.incomeRank ?? 99) - (b.incomeRank ?? 99));
    let rank = 0;
    return accts.map(a => {
      if (a.role !== "income") return a;
      const r = income.findIndex(x => x.last4 === a.last4);
      return { ...a, incomeRank: r };
    });
  }

  function handleReorder(last4, dir) {
    setAccountsP(prev => {
      const income = prev.filter(a => a.role === "income").sort((a,b) => a.incomeRank - b.incomeRank);
      const idx = income.findIndex(a => a.last4 === last4);
      const swapIdx = dir === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= income.length) return prev;
      const a = income[idx], b = income[swapIdx];
      return prev.map(acct => {
        if (acct.last4 === a.last4) return { ...acct, incomeRank: b.incomeRank };
        if (acct.last4 === b.last4) return { ...acct, incomeRank: a.incomeRank };
        return acct;
      });
    });
    setHeroKey(k => k + 1);
  }

  function handleRemoveAccount(last4) {
    setAccountsP(prev => rerank(prev.filter(a => a.last4 !== last4)));
    showToast("Account removed");
  }

  function handleSetDueDay(last4, day) {
    setAccountsP(prev => prev.map(a => a.last4 === last4 ? { ...a, dueDay: day ? parseInt(day) : null } : a));
  }

  function handleAddAccount(l4, label, role) {
    if (accounts.find(a => a.last4 === l4)) { showToast("Account already exists"); return; }
    const nextRank = role === "income" ? accounts.filter(a => a.role === "income").length : null;
    setAccountsP(prev => [...prev, { last4: l4, label, role, incomeRank: nextRank }]);
    showToast("Account added");
  }

  const NAV = [
    { id:"home",     label:"Home",     Icon:IconHome     },
    { id:"history",  label:"History",  Icon:IconHistory  },
    { id:"settings", label:"Settings", Icon:IconSettings },
  ];

  return (
    <>
      <style>{S}</style>
      <div className="app">
        {toast && <div className="toast" key={toast}>{toast}</div>}

        {tab === "home" && (
          <HomeScreen
            accounts={accounts} snapshots={snapshots}
            safeToSpend={safeToSpend} residuals={residuals}
            thresholds={thresholds} thresholdMode={thresholdMode}
            heroKey={heroKey}
            smsText={smsText} setSmsText={setSmsText}
            smsResult={smsResult} onParseSMS={handleParseSMS}
            onConfirmCard={handleConfirmCardAccount}
            manualAcct={manualAcct} setManualAcct={setManualAcct}
            manualBal={manualBal} setManualBal={setManualBal}
            onManualSave={handleManualSave}
            latestBalance={latestBalance} firstBalance={firstBalance} dueThresholds={dueThresholds}
          />
        )}
        {tab === "history" && (
          <HistoryScreen snapshots={snapshots} accounts={accounts} />
        )}
        {tab === "settings" && (
          <SettingsScreen
            accounts={accounts} thresholds={thresholds} thresholdMode={thresholdMode}
            onSetRole={handleSetRole} onReorder={handleReorder}
            onRemoveAccount={handleRemoveAccount} onAddAccount={handleAddAccount}
            onSaveThresholds={setThresholdsP} onSaveThresholdMode={setThresholdModeP}
            dueThresholds={dueThresholds} onSaveDueThresholds={setDueThresholdsP}
            onSetDueDay={handleSetDueDay}
          />
        )}

        <nav className="nav">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} className={`nav-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <Icon /><span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
