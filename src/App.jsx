import { useState, useRef, Component } from "react";

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
  // Capital One: "…(1234) bal is $X" or "(1234) balance is $X"
  { regex: /\((\d{4})\)\s+bal(?:ance)?\s+is\s+\$([0-9,]+\.\d{2})/i, label: "Capital One" },
  // Broad parenthesis fallback: (1234) ... $X
  { regex: /\((\d{4})\)[^$]*\$([0-9,]+\.\d{2})/i, label: "Bank" },
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
//   { type: "digits", accountLast4, balance, label } — known account, save immediately
//   { type: "cardname", cardName, balance, label } — no digits, needs account confirmation
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
// role: "spending_bank" | "credit_card" | "bills_bank" | "holding"
// incomeRank: 0 = Primary, 1 = Secondary, 2 = Tertiary, etc. (null for spending)
// incomeLabel: custom label e.g. "Primary", "Secondary", "Backup"

const RANK_NAMES = ["Primary", "Secondary", "Tertiary", "Quaternary"];
function rankName(r) { return RANK_NAMES[r] ?? `#${r + 1}`; }

// ─── Safe-to-Spend Engine ────────────────────────────────────────────────────
// spending_bank total minus credit_card total = safe to spend
// bills_bank and holding are excluded

function computeWaterfall(accounts, latestBalance) {
  const spendingBanks = accounts
    .filter(a => a.role === "spending_bank")
    .sort((a, b) => (a.incomeRank ?? 99) - (b.incomeRank ?? 99));
  const creditCards = accounts.filter(a => a.role === "credit_card");

  const bankTotal = spendingBanks.reduce((s, a) => s + (latestBalance(a.last4) ?? 0), 0);
  const cardTotal = creditCards.reduce((s, a)  => s + (latestBalance(a.last4) ?? 0), 0);

  if (!spendingBanks.length) return { safeToSpend: null, residuals: {} };

  const safeToSpend = bankTotal - cardTotal;

  let remaining = cardTotal;
  const residuals = {};
  for (const acct of spendingBanks) {
    const bal = latestBalance(acct.last4) ?? 0;
    if (remaining <= 0)       { residuals[acct.last4] = bal; }
    else if (bal >= remaining){ residuals[acct.last4] = bal - remaining; remaining = 0; }
    else                      { residuals[acct.last4] = 0; remaining -= bal; }
  }
  return { safeToSpend, residuals };
}

// Bills bank health
function computeBillsHealth(accounts, bills, latestBalance) {
  const billsBanks = accounts.filter(a => a.role === "bills_bank");
  const totalBillsBal = billsBanks.reduce((s, a) => s + (latestBalance(a.last4) ?? 0), 0);
  const FREQ = { weekly:52, biweekly:26, semimonthly:24, monthly:12, quarterly:4, annual:1, onetime:0 };
  const monthlyTotal = bills.reduce((s, b) => {
    const myPct = parseFloat(b.myPct) || 100;
    return s + (parseFloat(b.amount)||0) * ((FREQ[b.frequency]||12)/12) * (myPct/100);
  }, 0);
  return { billsBanks, totalBillsBal, monthlyTotal };
}

// ─── Threshold Color ──────────────────────────────────────────────────────────
// mode: "dollar" | "percent"
// For percent mode, startingBalance is the first-ever recorded balance for that account

function bandColor(value, thresholds, mode, startingBalance) {
  if (value === null) return "var(--muted)";
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

const S2S_VERSION = "v2.3";

function initStorage() {
  try {
    if (localStorage.getItem("s2s_version") !== S2S_VERSION) {
      const savedTheme = localStorage.getItem("s2s_theme");
      Object.keys(localStorage).filter(k=>k.startsWith("s2s_")).forEach(k=>localStorage.removeItem(k));
      localStorage.setItem("s2s_version", S2S_VERSION);
      if (savedTheme) localStorage.setItem("s2s_theme", savedTheme);
    }
    applyTheme(localStorage.getItem("s2s_theme") || "warm");
  } catch {}
}
initStorage();

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function resetAllData() {
  try {
    Object.keys(localStorage).filter(k=>k.startsWith("s2s_")).forEach(k=>localStorage.removeItem(k));
    window.location.reload();
  } catch {}
}

// ─── Defaults (used only on first launch) ────────────────────────────────────

const DEFAULT_ACCOUNTS = [];

const DEFAULT_SNAPSHOTS = [];
const DEFAULT_THRESHOLDS     = { hi: "60", mid: "30", lo: "15" };
const DEFAULT_THRESHOLD_MODE = "percent"; // "dollar" | "percent"
const DEFAULT_DUE_THRESHOLDS    = { green: "14", yellow: "7",    red: "3"    }; // days until due
const DEFAULT_INVEST_THRESHOLDS = { green: "75",  yellow: "40",  red: "10"   }; // % of goal

// ─── Styles ───────────────────────────────────────────────────────────────────


// ─── Theme Definitions ────────────────────────────────────────────────────────
const THEMES = {
 dark: {
  "--bg":          "#0F172A",
  "--bg2":         "#111827",
  "--card":        "#1E293B",
  "--card2":       "#273449",
  "--border":      "#334155",
  "--border2":     "#475569",
  "--text":        "#F8FAFC",
  "--text2":       "#CBD5E1",
  "--muted":       "#94A3B8",
  "--muted2":      "#64748B",
  "--muted3":      "#475569",
  "--input-bg":    "#111827",
  "--nav-bg":      "#0F172A",
  "--label-color": "#818CF8",
  "--hero-sub":    "#94A3B8",
  "--accent":      "#6366F1",
  "--accent2":     "#818CF8",
  "--positive":    "#34D399",
  "--shadow":      "rgba(0,0,0,0.35)",
  "--card-shadow": "0 10px 25px rgba(0,0,0,.30)",
},
  light: {
  "--bg":          "#F8FAFC",
  "--bg2":         "#EBEEF3",
  "--card":        "#FFFFFF",
  "--card2":       "#F4F7FA",
  "--border":      "#E2E8F0",
  "--border2":     "#CBD5E1",
  "--text":        "#0F172A",
  "--text2":       "#475569",
  "--muted":       "#64748B",
  "--muted2":      "#94A3B8",
  "--muted3":      "#CBD5E1",
  "--input-bg":    "#FFFFFF",
  "--nav-bg":      "#FFFFFF",
  "--label-color": "#5E5CE6",
  "--hero-sub":    "#64748B",
  "--accent":      "#5E5CE6",
  "--accent2":     "#7B79FF",
  "--positive":    "#30D158",
  "--shadow":      "rgba(0,0,0,0.06)",
  "--card-shadow": "0 8px 20px rgba(0,0,0,.08)",
},
  warm: {
  "--bg":          "#FAF7F2",
  "--bg2":         "#F2EDE5",
  "--card":        "#FFFEFB",
  "--card2":       "#F5F0E8",
  "--border":      "#E7E0D5",
  "--border2":     "#D5C9B8",
  "--text":        "#2B2118",
  "--text2":       "#5B4A3A",
  "--muted":       "#7A6856",
  "--muted2":      "#9B8A79",
  "--muted3":      "#EDE5D8",
  "--input-bg":    "#FFFEFB",
  "--nav-bg":      "#FFFEFB",
  "--label-color": "#6D5ACF",
  "--hero-sub":    "#7A6856",
  "--accent":      "#6D5ACF",
  "--accent2":     "#8B76E8",
  "--positive":    "#2DB96A",
  "--shadow":      "rgba(0,0,0,0.05)",
  "--card-shadow": "0 8px 20px rgba(43,33,24,.08)",
},
};

function applyTheme(theme) {
  const vars = THEMES[theme] || THEMES.warm;
  const root = document.documentElement;
  Object.entries(vars).forEach(([k,v]) => root.style.setProperty(k, v));
  root.setAttribute("data-theme", theme);
}

const S = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

  * { box-sizing:border-box; margin:0; padding:0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    overscroll-behavior: none;
  }

  .app {
    max-width: 430px;
    margin: 0 auto;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .screen { flex:1; padding:0 0 96px; overflow-y:auto; }

  /* ── Header ── */
  .header { padding:52px 24px 16px; display:flex; justify-content:space-between; align-items:flex-end; }
  .header-label { font-size:28px; font-weight:700; letter-spacing:-0.5px; color:var(--text); }
  .header-date  { font-size:13px; font-weight:400; color:var(--muted); }

  /* ── Hero ── */
  .hero { padding:8px 24px 28px; display:flex; flex-direction:column; align-items:center; }
  .hero-ring-wrap {
    position:relative; width:200px; height:200px; margin-bottom:20px;
  }
  .hero-ring-center {
    position:absolute; top:0; left:0; right:0; bottom:0;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
  }
  .hero-eyebrow { font-size:11px; font-weight:600; letter-spacing:0.8px; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  .hero-amount  { font-size:40px; font-weight:700; line-height:1; letter-spacing:-1px; font-variant-numeric:tabular-nums; }
  .hero-amount.anim { animation:breathe 1.6s ease-out forwards; }
  @keyframes breathe { 0%{opacity:0;transform:scale(.96)} 60%{opacity:1;transform:scale(1.01)} 100%{opacity:1;transform:scale(1)} }
  .hero-sub { font-size:12px; color:var(--hero-sub); margin-top:3px; }
  .hero-stats { display:flex; width:100%; border-top:1px solid var(--border); }
  .hero-stat { flex:1; padding:14px 0; text-align:center; }
  .hero-stat + .hero-stat { border-left:1px solid var(--border); }
  .hero-stat-label { font-size:11px; font-weight:500; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .hero-stat-val   { font-size:19px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }

  /* ── Cards ── */
  .card { background:var(--card); border-radius:16px; box-shadow:var(--card-shadow); overflow:hidden; }
  .card-wrap { margin:0 16px 12px; }
  .card-wrap-section { margin:0 16px 12px; }

  .divider { height:1px; background:var(--border); margin:0 24px 16px; }
  .section-label {
    font-size:13px; font-weight:600; color:var(--muted);
    text-transform:uppercase; letter-spacing:0.5px;
    padding:0 24px; margin-bottom:8px; margin-top:4px;
  }

  /* ── Account rows ── */
  .account-list { margin:0 16px 12px; display:flex; flex-direction:column; }
  .account-card {
    background:var(--card); box-shadow:var(--card-shadow);
    border-radius:14px; padding:14px 16px;
    display:flex; justify-content:space-between; align-items:center;
    margin-bottom:6px;
  }
  .account-card.rank-0 { border-left:3px solid var(--positive); }
  .account-card.rank-1 { border-left:3px solid var(--accent2); }
  .account-card-left { display:flex; align-items:center; gap:12px; }
  .acct-rank-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .account-label   { font-size:14px; font-weight:500; color:var(--text); }
  .account-last4   { font-size:12px; color:var(--muted); margin-top:2px; }
  .account-balance { font-size:17px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }
  .account-balance.primary-bal { color:var(--positive); }
  .account-balance.no-data     { color:var(--muted2); font-size:14px; }
  .rank-badge {
    font-size:10px; font-weight:600; letter-spacing:.5px;
    padding:2px 7px; border-radius:10px; display:inline-block;
  }

  /* ── Due date stripe on cards ── */
  .account-card.due-safe   { border-left:3px solid #30D158; }
  .account-card.due-warn   { border-left:3px solid #FF9F0A; }
  .account-card.due-danger { border-left:3px solid #FF453A; }

  /* ── SMS ── */
  .sms-panel { margin:0 16px 16px; background:var(--card2); border:1px dashed var(--border2); border-radius:16px; padding:18px; }
  .sms-panel-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); margin-bottom:10px; display:flex; align-items:center; gap:8px; }
  .sms-textarea { width:100%; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:13px; padding:12px; resize:none; outline:none; min-height:80px; transition:border-color .2s; }
  .sms-textarea:focus { border-color:var(--accent); }
  .sms-textarea::placeholder { color:var(--muted2); }
  .sms-parse-btn { width:100%; margin-top:10px; background:var(--accent); color:#fff; border:none; border-radius:10px; padding:12px; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; }
  .sms-result { margin-top:10px; font-size:13px; padding:10px 12px; border-radius:8px; }
  .sms-result.success { background:#30D15812; color:#30D158; }
  .sms-result.error   { background:#FF453A12; color:#FF453A; }

  /* ── Manual entry ── */
  .manual-panel { margin:0 16px 20px; background:var(--card2); border:1px dashed var(--border2); border-radius:16px; padding:18px; }
  .manual-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#FF9F0A; margin-bottom:12px; }
  .select-input { width:100%; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:14px; padding:11px 13px; outline:none; margin-bottom:10px; appearance:none; cursor:pointer; }

  /* ── History ── */
  .history-list { padding:0 16px; display:flex; flex-direction:column; gap:6px; }
  .history-item { background:var(--card); box-shadow:var(--card-shadow); border-radius:12px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; }
  .history-time    { font-size:11px; color:var(--muted); margin-top:2px; }
  .history-account { font-size:14px; font-weight:500; color:var(--text2); }
  .history-source  { font-size:10px; padding:2px 7px; border-radius:10px; margin-top:4px; display:inline-block; }
  .src-manual { background:#FF9F0A20; color:#FF9F0A; }
  .src-sms    { background:#818CF820; color:#818CF8; }
  .src-api    { background:#30D15820; color:#30D158; }
  .history-balance { font-size:18px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }
  .history-empty   { text-align:center; color:var(--muted2); padding:48px 24px; font-size:14px; line-height:1.6; }

  /* ── Settings ── */
  .settings-section { padding:0 16px; margin-bottom:20px; }
  .settings-row {
    background:var(--card); box-shadow:var(--card-shadow);
    border-radius:12px; padding:14px 16px;
    display:flex; justify-content:space-between; align-items:center;
    margin-bottom:6px;
  }
  .settings-row-label { font-size:15px; color:var(--text2); }
  .settings-row-sub   { font-size:12px; color:var(--muted); margin-top:2px; }
  .pill { font-size:11px; padding:5px 12px; border-radius:20px; font-weight:600; cursor:pointer; border:none; font-family:inherit; }
  .pill-green  { background:#30D15815; color:#30D158; }
  .pill-teal   { background:#30D158; color:#fff; }
  .pill-red    { background:#FF453A15; color:#FF453A; }
  .pill-purple { background:var(--accent)20; color:var(--accent); }
  .pill-up     { background:var(--muted3); color:var(--text2); }
  .pill-down   { background:var(--muted3); color:var(--text2); }

  /* ── Forms ── */
  .add-form { background:var(--card2); border:1px dashed var(--border2); border-radius:16px; padding:18px; margin:0 16px 20px; }
  .add-form-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#FF9F0A; margin-bottom:12px; }
  .input-row { display:flex; gap:10px; }
  .text-input { flex:1; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:14px; padding:11px 13px; outline:none; transition:border-color .2s; min-width:0; }
  .text-input:focus { border-color:var(--accent); }
  .text-input::placeholder { color:var(--muted2); }
  .add-btn { background:#FF9F0A; color:#fff; border:none; border-radius:10px; padding:11px 18px; font-family:inherit; font-size:14px; font-weight:700; cursor:pointer; white-space:nowrap; }

  /* ── Role toggle ── */
  .role-toggle { display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap; }
  .role-btn { flex:1; min-width:70px; padding:9px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--muted); font-family:inherit; font-size:12px; font-weight:600; cursor:pointer; transition:all .15s; }
  .role-btn.active { background:var(--muted3); color:var(--text); border-color:var(--border2); }

  /* ── Threshold panel ── */
  .threshold-panel { background:var(--card2); border:1px solid var(--border2); border-radius:16px; padding:18px; margin:0 16px 20px; }
  .threshold-title { font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  .threshold-hint  { font-size:12px; color:var(--muted2); margin-bottom:14px; line-height:1.5; }
  .mode-toggle { display:flex; gap:6px; margin-bottom:14px; }
  .mode-btn { flex:1; padding:8px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--muted); font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; }
  .mode-btn.active { background:var(--muted3); color:var(--text); border-color:var(--border2); }
  .band-preview { display:flex; height:4px; border-radius:2px; overflow:hidden; margin-bottom:14px; gap:2px; }
  .band-seg { flex:1; border-radius:2px; }
  .threshold-row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
  .threshold-swatch { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
  .threshold-input { flex:1; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:14px; padding:10px 13px; outline:none; transition:border-color .2s; min-width:0; }
  .threshold-input:focus { border-color:var(--muted); }
  .threshold-input::placeholder { color:var(--muted2); }
  .threshold-unit { font-size:13px; color:var(--muted); min-width:16px; }
  .threshold-save { width:100%; margin-top:6px; background:var(--muted3); color:var(--text2); border:none; border-radius:10px; padding:11px; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; }

  /* ── Bills ── */
  .bill-list { padding:0 16px; display:flex; flex-direction:column; gap:6px; margin-bottom:80px; }
  .bill-card { background:var(--card); box-shadow:var(--card-shadow); border-radius:14px; padding:16px 18px; }
  .bill-card-top { display:flex; justify-content:space-between; align-items:flex-start; }
  .bill-name { font-size:15px; font-weight:600; color:var(--text); }
  .bill-meta { font-size:12px; color:var(--muted); margin-top:3px; line-height:1.6; }
  .bill-amount { font-size:20px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums; }
  .bill-amount-sub { font-size:11px; color:var(--muted); text-align:right; margin-top:2px; }
  .bill-tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
  .bill-tag { font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; }
  .tag-auto   { background:#30D15815; color:#30D158; }
  .tag-fixed  { background:var(--accent)20; color:var(--accent); }
  .tag-var    { background:#FF9F0A18; color:#FF9F0A; }
  .tag-ef     { background:#FBBF2418; color:#FBBF24; }
  .tag-retire { background:var(--accent2)18; color:var(--accent2); }
  .bill-actions { display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border); }
  .bill-action-btn { flex:1; padding:8px; border-radius:10px; border:none; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  .btn-edit   { background:var(--muted3); color:var(--text2); }
  .btn-delete { background:#FF453A15; color:#FF453A; }
  .fab { position:fixed; bottom:100px; right:20px; width:52px; height:52px; border-radius:26px; background:var(--accent); border:none; color:#fff; font-size:26px; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 20px rgba(99,102,241,.35); z-index:50; }

  /* ── Modal ── */
  .modal-overlay { position:fixed; inset:0; background:#00000099; z-index:200; display:flex; align-items:flex-end; }
  .modal { background:var(--card); border-radius:20px 20px 0 0; padding:24px 20px 40px; width:100%; max-height:90vh; overflow-y:auto; }
  .modal-title { font-size:18px; font-weight:700; color:var(--text); font-family:inherit; margin-bottom:20px; letter-spacing:-0.3px; }
  .form-label { font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin-bottom:6px; display:block; }
  .form-group { margin-bottom:16px; }
  .form-row { display:flex; gap:10px; }
  .form-row .form-group { flex:1; }
  .form-input { width:100%; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:14px; padding:11px 13px; outline:none; transition:border-color .2s; }
  .form-input:focus { border-color:var(--accent); }
  .form-input::placeholder { color:var(--muted2); }
  .form-select { width:100%; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text2); font-family:inherit; font-size:14px; padding:11px 13px; outline:none; appearance:none; cursor:pointer; }
  .form-toggle-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--border); }
  .form-toggle-label { font-size:14px; color:var(--text2); }
  .toggle { width:42px; height:24px; border-radius:12px; border:none; cursor:pointer; position:relative; transition:background .2s; flex-shrink:0; }
  .toggle.on  { background:var(--positive); }
  .toggle.off { background:var(--muted3); }
  .toggle-knob { width:18px; height:18px; border-radius:9px; background:#fff; position:absolute; top:3px; transition:left .2s; }
  .toggle.on  .toggle-knob { left:21px; }
  .toggle.off .toggle-knob { left:3px; }
  .form-save-btn { width:100%; margin-top:20px; background:var(--accent); color:#fff; border:none; border-radius:12px; padding:14px; font-family:inherit; font-size:15px; font-weight:700; cursor:pointer; }
  .form-cancel-btn { width:100%; margin-top:10px; background:transparent; color:var(--muted); border:none; padding:12px; font-family:inherit; font-size:14px; cursor:pointer; }

  /* ── Planner ── */
  .planner-hero { background:var(--card); box-shadow:var(--card-shadow); border-radius:16px; padding:24px 20px; margin:0 16px 16px; }
  .planner-row { display:flex; justify-content:space-between; align-items:baseline; padding:10px 0; border-bottom:1px solid var(--border); }
  .planner-row:last-child { border-bottom:none; }
  .planner-lbl { font-size:13px; color:var(--muted); }
  .planner-val { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
  .planner-section { padding:0 16px; margin-bottom:28px; }
  .planner-bill-row { background:var(--card); box-shadow:var(--card-shadow); border-radius:12px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
  .planner-bill-name { font-size:14px; color:var(--text2); }
  .planner-bill-sub  { font-size:11px; color:var(--muted); margin-top:2px; }
  .planner-bill-amt  { font-size:16px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }

  /* ── Roadmap ── */
  .roadmap-visual { position:relative; padding:20px 16px 40px; overflow:hidden; }
  .road-svg { width:100%; display:block; }
  .roadmap-edit-date { font-size:11px; color:var(--accent); cursor:pointer; text-decoration:underline; }
  .roadmap-container { padding:16px 16px 100px; }
  .roadmap-step { display:flex; gap:14px; align-items:flex-start; }
  .step-spine { display:flex; flex-direction:column; align-items:center; width:16px; flex-shrink:0; }
  .step-dot { width:16px; height:16px; border-radius:8px; flex-shrink:0; border:2px solid transparent; }
  .step-dot.done    { background:var(--positive); border-color:var(--positive); }
  .step-dot.current { background:var(--bg); border-color:var(--accent); box-shadow:0 0 0 3px var(--accent)30; }
  .step-dot.future  { background:var(--muted3); border-color:var(--muted3); }
  .step-line { width:2px; flex:1; min-height:20px; margin:3px 0; }
  .step-line.done   { background:var(--positive)40; }
  .step-line.future { background:var(--muted3); }
  .step-body { flex:1; padding-bottom:16px; }
  .step-label { font-size:15px; font-weight:600; margin-bottom:4px; }
  .step-label.done    { color:var(--muted); }
  .step-label.current { color:var(--text); }
  .step-label.future  { color:var(--muted2); }
  .step-badge { font-size:10px; font-weight:600; letter-spacing:1px; padding:2px 8px; border-radius:10px; display:inline-block; margin-bottom:6px; }
  .badge-current { background:var(--accent)20; color:var(--accent); }
  .badge-done    { background:var(--muted3); color:var(--muted); }
  .roadmap-actions { display:flex; gap:6px; flex-wrap:wrap; }
  .roadmap-btn { font-size:11px; padding:4px 10px; border-radius:8px; border:none; font-family:inherit; font-weight:600; cursor:pointer; }
  .rmbtn-done    { background:var(--positive)20; color:var(--positive); }
  .rmbtn-current { background:var(--accent)20; color:var(--accent); }
  .rmbtn-del     { background:#FF453A15; color:#FF453A; }
  .rmbtn-up      { background:var(--muted3); color:var(--text2); }
  .rmbtn-down    { background:var(--muted3); color:var(--text2); }

  /* ── Invest ── */
  .invest-list { padding:0 16px; display:flex; flex-direction:column; gap:8px; margin-bottom:80px; }
  .invest-card { background:var(--card); box-shadow:var(--card-shadow); border-radius:14px; padding:18px; }
  .invest-top  { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
  .invest-name { font-size:15px; font-weight:600; color:var(--text); }
  .invest-date { font-size:11px; color:var(--muted); margin-top:3px; }
  .invest-pct  { font-size:28px; font-weight:700; color:var(--accent); font-variant-numeric:tabular-nums; }
  .invest-track { display:flex; justify-content:space-between; margin-bottom:6px; }
  .invest-track-lbl { font-size:11px; color:var(--muted); }
  .invest-track-val { font-size:13px; color:var(--text2); font-variant-numeric:tabular-nums; }
  .progress-bar  { height:5px; border-radius:3px; background:var(--muted3); overflow:hidden; margin-bottom:12px; }
  .progress-fill { height:100%; border-radius:3px; background:linear-gradient(90deg, var(--accent), var(--accent2)); transition:width .5s ease; }
  .invest-actions { display:flex; gap:8px; padding-top:12px; border-top:1px solid var(--border); }
  .invest-tab-hero { background:var(--card); box-shadow:var(--card-shadow); border-radius:16px; padding:24px 20px; margin:0 16px 16px; }
  .invest-total-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:var(--muted2); margin-bottom:8px; }
  .invest-total-val { font-size:48px; font-weight:700; color:var(--accent); line-height:1; font-variant-numeric:tabular-nums; }
  .invest-total-sub { font-size:12px; color:var(--muted); margin-top:6px; }
  .holding-list { padding:0 16px; display:flex; flex-direction:column; gap:6px; margin-bottom:16px; }
  .holding-card { background:var(--card); box-shadow:var(--card-shadow); border-radius:14px; padding:16px 18px; display:flex; justify-content:space-between; align-items:center; }
  .holding-label { font-size:14px; font-weight:500; color:var(--text2); }
  .holding-last4  { font-size:12px; color:var(--muted); margin-top:2px; }
  .holding-bal    { font-size:18px; font-weight:600; color:var(--accent); font-variant-numeric:tabular-nums; }

  /* ── Dashboard ── */
  .dash-grid { padding:0 16px; display:flex; flex-direction:column; gap:10px; margin-bottom:20px; }
  .dash-card { background:var(--card); box-shadow:var(--card-shadow); border-radius:16px; padding:18px 20px; }
  .dash-card-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:var(--muted2); margin-bottom:8px; }
  .dash-card-value { font-size:34px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
  .dash-card-sub   { font-size:12px; color:var(--muted); margin-top:6px; }
  .dash-row { display:flex; gap:10px; }
  .dash-half { flex:1; }
  .dash-card.small .dash-card-value { font-size:22px; }
  .upcoming-list { display:flex; flex-direction:column; gap:0; margin-top:4px; }
  .upcoming-item { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border); }
  .upcoming-item:last-child { border-bottom:none; }
  .upcoming-name { font-size:13px; color:var(--text2); }
  .upcoming-due  { font-size:11px; color:var(--muted); margin-top:2px; }
  .upcoming-amt  { font-size:14px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }
  .suggest-card { background:linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%); border-radius:16px; padding:18px 20px; margin:0 16px 12px; box-shadow:0 4px 20px var(--accent)30; }
  .suggest-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:rgba(255,255,255,.65); margin-bottom:6px; }
  .suggest-title { font-size:18px; font-weight:700; color:#fff; margin-bottom:4px; letter-spacing:-0.3px; }
  .suggest-reason { font-size:12px; color:rgba(255,255,255,.72); line-height:1.5; }

  /* ── Bills table ── */
  .view-toggle { display:flex; gap:6px; padding:0 16px 12px; overflow-x:auto; scrollbar-width:none; }
  .view-btn { flex-shrink:0; padding:7px 14px; border-radius:20px; border:none; background:var(--muted3); color:var(--muted); font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; }
  .view-btn.active { background:var(--accent); color:#fff; }
  .bills-table { width:100%; border-collapse:collapse; font-size:13px; }
  .bills-table th { text-align:left; padding:8px 12px; font-size:10px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted2); border-bottom:1px solid var(--border); }
  .bills-table td { padding:12px; border-bottom:1px solid var(--card); color:var(--text2); vertical-align:middle; }
  .bills-table-wrap { margin:0 16px 80px; background:var(--card); box-shadow:var(--card-shadow); border-radius:14px; overflow:hidden; overflow-x:auto; }
  .tbl-input { background:transparent; border:none; color:var(--text2); font-family:inherit; font-size:13px; width:100%; outline:none; padding:2px 0; }

  /* ── Waterfall strip ── */
  .waterfall-strip { margin:0 24px 20px; display:flex; gap:3px; height:4px; border-radius:2px; overflow:hidden; }
  .waterfall-seg   { border-radius:2px; transition:flex .5s ease, background .5s ease; min-width:3px; }

  /* ── Accounts screen ── */
  .float-row { display:flex; align-items:center; gap:10px; padding:8px 0; }
  .float-bar { height:4px; border-radius:2px; background:var(--muted3); overflow:hidden; flex:1; min-width:60px; }
  .float-fill { height:100%; border-radius:2px; transition:width .4s ease; }

  /* ── Roadmap visual ── */
  .milestone-popup { position:absolute; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:8px 12px; font-size:12px; color:var(--text2); max-width:140px; pointer-events:none; box-shadow:var(--card-shadow); }
  .milestone-date { font-size:10px; color:var(--muted); margin-top:3px; }

  /* ── Nav ── */
  .nav {
    position:fixed; bottom:0; left:50%; transform:translateX(-50%);
    width:100%; max-width:430px;
    background:var(--nav-bg);
    border-top:1px solid var(--border);
    display:flex; overflow-x:auto; overflow-y:hidden;
    padding:10px 0 28px; z-index:100;
    scrollbar-width:none; -ms-overflow-style:none;
    backdrop-filter:blur(20px);
  }
  .nav::-webkit-scrollbar { display:none; }
  .nav-btn { flex:0 0 auto; min-width:60px; display:flex; flex-direction:column; align-items:center; gap:3px; background:none; border:none; cursor:pointer; padding:4px 8px; }
  .nav-icon { width:18px; height:18px; }
  .nav-label { font-family:inherit; font-size:9px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; transition:color .15s; }
  .nav-btn.active .nav-label { color:var(--accent); }
  .nav-btn        .nav-label { color:var(--muted); }
  .nav-btn.active .nav-icon path,
  .nav-btn.active .nav-icon rect,
  .nav-btn.active .nav-icon circle { stroke:var(--accent) !important; }
  .nav-btn        .nav-icon path,
  .nav-btn        .nav-icon rect,
  .nav-btn        .nav-icon circle { stroke:var(--muted); transition:stroke .15s; }

  /* ── Toast ── */
  .toast { position:fixed; top:20px; left:50%; transform:translateX(-50%); background:var(--text); color:var(--bg); font-family:inherit; font-size:13px; font-weight:600; padding:10px 20px; border-radius:24px; z-index:999; animation:toastIn .25s ease, toastOut .3s ease 2s forwards; pointer-events:none; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,.15); }
  @keyframes toastIn  { from{opacity:0;transform:translateX(-50%) translateY(-8px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  @keyframes toastOut { from{opacity:1} to{opacity:0} }

  .screen-title { font-size:28px; font-weight:700; color:var(--text); padding:52px 24px 24px; font-family:inherit; letter-spacing:-0.5px; }

  /* ── Bills scale ── */
  .scale-track { height:10px; background:var(--muted3); border-radius:5px; overflow:visible; position:relative; margin-bottom:8px; }
  .scale-fill  { height:100%; border-radius:5px; position:absolute; left:0; top:0; transition:width .5s ease; }
  .trough-info { display:flex; justify-content:space-between; background:var(--bg); border-radius:10px; padding:12px 14px; margin-top:10px; }
  .trough-label { font-size:12px; color:var(--muted); margin-bottom:2px; }
  .trough-val   { font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; }

  /* ── History section in settings ── */
  .history-section { padding:0 16px; margin-bottom:20px; }
`;


// ─── Rank dot colors ──────────────────────────────────────────────────────────

const RANK_COLORS = ["#00D4AA", "#9B88FF", "#F5C842", "#F5A623"];
function rankColor(r) { return RANK_COLORS[r % RANK_COLORS.length]; }

// ─── Icons ────────────────────────────────────────────────────────────────────

const IconDashboard = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </svg>
);
const IconBills = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
  </svg>
);
const IconPlanner = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
    <path d="M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/>
  </svg>
);
const IconRoadmap = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
    <circle cx="12" cy="9" r="2.5"/>
  </svg>
);

const IconAccounts = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="7" r="4"/>
    <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/>
    <path d="M16 3.13a4 4 0 010 7.75"/>
    <path d="M21 21v-2a4 4 0 00-3-3.87"/>
  </svg>
);

const IconInvest = () => (
  <svg
    className="nav-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 20 H20" />
    <path d="M4 20 V4" />
    <path d="M6 16 L11 12 L15 13 L19 7" />
    <path d="M17 7 H19 V9" />
  </svg>
);

const IconHome = () => (
  <svg
    className="nav-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Card outline */}
    <rect x="3.5" y="6" width="17" height="12" rx="2" />

    {/* Magnetic stripe */}
    <path d="M3.5 10 H20.5" />

    {/* Chip */}
    <rect x="6.5" y="12.2" width="3" height="2.4" rx=".4" />

    {/* Card number */}
    <path d="M12 14.5 H17" />
  </svg>
);
const IconHistory = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
  </svg>
);
const IconSettings = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

// ─── HomeScreen ───────────────────────────────────────────────────────────────


// ─── Ring SVG Component ───────────────────────────────────────────────────────
function SafeToSpendRing({ pct, color, size=200 }) {
  const r = size * 0.4;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const clampedPct = Math.min(100, Math.max(0, pct || 0));
  const dash = (clampedPct / 100) * circ;
  return (
    <svg width={size} height={size} style={{position:"absolute",top:0,left:0}}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--muted3)" strokeWidth="10"/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25}
        strokeLinecap="round"
        style={{transition:"stroke-dasharray 0.8s ease, stroke 0.6s ease"}}/>
    </svg>
  );
}


// ─── Account Type Icons ───────────────────────────────────────────────────────
function AccountIcon({ role, label }) {
  const l = (label || "").toLowerCase();
  if (role === "spending_bank") {
    if (l.includes("chase"))   return <span style={{fontSize:18}}>🏦</span>;
    if (l.includes("ally"))    return <span style={{fontSize:18}}>💰</span>;
    if (l.includes("saving"))  return <span style={{fontSize:18}}>💰</span>;
    return <span style={{fontSize:18}}>🏦</span>;
  }
  if (role === "bills_bank")   return <span style={{fontSize:18}}>📋</span>;
  if (role === "credit_card") {
    if (l.includes("amex"))    return <span style={{fontSize:18}}>💎</span>;
    if (l.includes("venture")) return <span style={{fontSize:18}}>✈️</span>;
    if (l.includes("sapphire"))return <span style={{fontSize:18}}>💠</span>;
    return <span style={{fontSize:18}}>💳</span>;
  }
  if (role === "holding") {
    if (l.includes("roth") || l.includes("ira")) return <span style={{fontSize:18}}>📈</span>;
    if (l.includes("401"))     return <span style={{fontSize:18}}>🏛️</span>;
    if (l.includes("broker"))  return <span style={{fontSize:18}}>📊</span>;
    return <span style={{fontSize:18}}>📈</span>;
  }
  return <span style={{fontSize:18}}>🏦</span>;
}

function RoleColors(role) {
  if (role === "spending_bank") return { bg:"#E8FBF0", color:"#30D158" };
  if (role === "bills_bank")    return { bg:"#EEEEFF", color:"var(--accent)" };
  if (role === "credit_card")   return { bg:"#FFF5E6", color:"#FF9F0A" };
  if (role === "holding")       return { bg:"#F0F0F5", color:"var(--muted)" };
  return { bg:"var(--card2)", color:"var(--muted)" };
}


// ─── Custom Parse Rules Engine ────────────────────────────────────────────────

function tokenizeText(text) {
  return text.trim().split(/\s+/).map((token, index) => ({
    index,
    raw: token,
    display: token.replace(/[^\w$.,*()]/g, "") || token,
    isCurrency: /\$[\d,]+\.?\d*/.test(token) || /[\d,]+\.\d{2}/.test(token),
    is4Digits: /\d{4}/.test(token.replace(/\D/g,"")),
    isWord: /^[a-zA-Z]{3,}/.test(token),
  }));
}

function extractLast4(token) {
  const digits = token.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function extractBalanceFromToken(token) {
  const clean = token.replace(/[$,]/g, "");
  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

function applyCustomRule(rule, text) {
  try {
    const tokens = tokenizeText(text);
    if (rule.identifierType === "last4") {
      const idTok = tokens[rule.identifierTokenIndex];
      if (!idTok) return null;
      const last4 = extractLast4(idTok.raw);
      if (!last4) return null;
      const balance = extractBalanceFromToken(tokens[rule.balanceTokenIndex]?.raw || "");
      if (balance === null) return null;
      return { type:"digits", accountLast4:last4, balance, label:rule.name };
    } else if (rule.identifierType === "keyword") {
      if (!text.toLowerCase().includes(rule.identifierValue.toLowerCase())) return null;
      const balance = extractBalanceFromToken(tokens[rule.balanceTokenIndex]?.raw || "");
      if (balance === null) return null;
      return { type:"digits", accountLast4:rule.mappedLast4, balance, label:rule.name };
    }
  } catch { return null; }
  return null;
}

function runCustomRules(text, customRules, priority) {
  for (const rule of (customRules||[]).filter(r=>r.priority===priority)) {
    const result = applyCustomRule(rule, text);
    if (result) return result;
  }
  return null;
}

function detectBankName(text) {
  const t = text.toLowerCase();
  if (t.includes("chase"))         return "Chase";
  if (t.includes("capital one"))   return "Capital One";
  if (t.includes("pnc"))           return "PNC";
  if (t.includes("citi"))          return "Citi";
  if (t.includes("amex")||t.includes("american express")) return "Amex";
  if (t.includes("bank of america")||t.includes("bofa"))  return "Bank of America";
  if (t.includes("wells fargo"))   return "Wells Fargo";
  if (t.includes("discover"))      return "Discover";
  if (t.includes("ally"))          return "Ally";
  if (t.includes("usaa"))          return "USAA";
  if (t.includes("synchrony"))     return "Synchrony";
  if (t.includes("barclays"))      return "Barclays";
  return "";
}

// ─── Rule Builder Modal ───────────────────────────────────────────────────────

function RuleBuilderModal({ accounts, onSave, onCancel }) {
  const [step, setStep]           = useState("paste");
  const [sampleText, setSample]   = useState("");
  const [tokens, setTokens]       = useState([]);
  const [idType, setIdType]       = useState(null);
  const [idTokenIdx, setIdTokenIdx]   = useState(null);
  const [balTokenIdx, setBalTokenIdx] = useState(null);
  const [mappedLast4, setMappedLast4] = useState("");
  const [ruleName, setRuleName]   = useState("");
  const [priority, setPriority]   = useState("high");

  function handlePaste() {
    if (!sampleText.trim()) return;
    setTokens(tokenizeText(sampleText));
    setStep("identify");
  }

  function handleIdToken(idx) {
    const tok = tokens[idx];
    if (!tok) return;
    setIdType(tok.is4Digits ? "last4" : "keyword");
    setIdTokenIdx(idx);
    setStep("balance");
  }

  function handleBalToken(idx) {
    if (idx === idTokenIdx) return;
    setBalTokenIdx(idx);
    setRuleName(detectBankName(sampleText) || "");
    setStep(idType === "keyword" ? "map" : "name");
  }

  function handleSave() {
    if (!ruleName.trim()) return;
    if (idTokenIdx === null || balTokenIdx === null) return;
    try {
      const identifierValue = idType === "keyword" && tokens[idTokenIdx]
        ? tokens[idTokenIdx].raw.replace(/[^a-zA-Z0-9]/g,"")
        : null;
      onSave({
        id: Date.now(),
        name: ruleName.trim(),
        priority,
        identifierType: idType,
        identifierTokenIndex: idTokenIdx,
        identifierValue,
        mappedLast4: idType === "keyword" ? mappedLast4 : null,
        balanceTokenIndex: balTokenIdx,
        sampleText,
      });
    } catch(e) {
      console.error("Rule save error:", e);
    }
  }

  const Tok = ({ tok, i, onTap }) => {
    const isId  = i === idTokenIdx;
    const isBal = i === balTokenIdx;
    return (
      <button onClick={()=>onTap(i)} style={{
        display:"inline-block", margin:"3px 2px",
        padding:"5px 10px", borderRadius:8,
        border:`1.5px solid ${isId?"var(--accent)":isBal?"var(--positive)":"var(--border)"}`,
        background: isId?"var(--accent)20":isBal?"var(--positive)20":"var(--input-bg)",
        color: isId?"var(--accent)":isBal?"var(--positive)":"var(--text2)",
        fontFamily:"inherit", fontSize:13, fontWeight:(isId||isBal)?700:400,
        cursor:"pointer", transition:"all .1s",
      }}>
        {tok.display||tok.raw}
      </button>
    );
  };

  return (
    <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div className="modal">

        {step === "paste" && <>
          <div className="modal-title">New Parse Rule</div>
          <p style={{fontSize:13,color:"var(--muted)",marginBottom:16,lineHeight:1.6}}>
            Paste a sample balance text from your bank. You'll tap to identify the account and the balance amount.
          </p>
          <div className="form-group">
            <label className="form-label">Sample Bank Text</label>
            <textarea className="form-input" style={{minHeight:90,resize:"none"}}
              placeholder="Paste your bank's text here…"
              value={sampleText} onChange={e=>setSample(e.target.value)}/>
          </div>
          <button className="form-save-btn" onClick={handlePaste} disabled={!sampleText.trim()}>
            Next — Identify Account
          </button>
          <button className="form-cancel-btn" onClick={onCancel}>Cancel</button>
        </>}

        {step === "identify" && <>
          <div className="modal-title">Tap the Account ID</div>
          <p style={{fontSize:13,color:"var(--muted)",marginBottom:12,lineHeight:1.6}}>
            Tap the word or number that identifies <strong style={{color:"var(--text)"}}>which account</strong> this is —
            last 4 digits, card name (e.g. "Sapphire"), or any unique word.
          </p>
          <div style={{background:"var(--card2)",borderRadius:12,padding:14,marginBottom:16,lineHeight:2.2}}>
            {tokens.map((tok,i)=><Tok key={i} tok={tok} i={i} onTap={handleIdToken}/>)}
          </div>
          <button className="form-cancel-btn" onClick={()=>setStep("paste")}>← Back</button>
        </>}

        {step === "balance" && <>
          <div className="modal-title">Tap the Balance</div>
          <p style={{fontSize:13,color:"var(--muted)",marginBottom:12,lineHeight:1.6}}>
            Now tap the <strong style={{color:"var(--text)"}}>dollar amount</strong>.
          </p>
          <div style={{background:"var(--card2)",borderRadius:12,padding:14,marginBottom:16,lineHeight:2.2}}>
            {tokens.map((tok,i)=><Tok key={i} tok={tok} i={i} onTap={handleBalToken}/>)}
          </div>
          <div style={{display:"flex",gap:10,fontSize:12,color:"var(--muted)",marginBottom:8}}>
            <span style={{color:"var(--accent)",fontWeight:600}}>Purple = account ID</span>
            <span>·</span>
            <span style={{color:"var(--positive)",fontWeight:600}}>Green = balance (tap to set)</span>
          </div>
          <button className="form-cancel-btn" onClick={()=>setStep("identify")}>← Back</button>
        </>}

        {step === "map" && <>
          <div className="modal-title">Which Account?</div>
          <p style={{fontSize:13,color:"var(--muted)",marginBottom:16,lineHeight:1.6}}>
            When the app sees <strong style={{color:"var(--text)"}}>"{tokens[idTokenIdx]?.raw}"</strong>,
            which account should it update?
          </p>
          <div className="form-group">
            <label className="form-label">Map to Account</label>
            <select className="form-select" value={mappedLast4} onChange={e=>setMappedLast4(e.target.value)}>
              <option value="">Select account…</option>
              {accounts.map(a=>(
                <option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>
              ))}
            </select>
          </div>
          <button className="form-save-btn" disabled={!mappedLast4} onClick={()=>setStep("name")}>
            Next — Name the Rule
          </button>
          <button className="form-cancel-btn" onClick={()=>setStep("balance")}>← Back</button>
        </>}

        {step === "name" && <>
          <div className="modal-title">Name Your Rule</div>
          {(idTokenIdx === null || balTokenIdx === null) && (
            <div style={{background:"#FF453A12",border:"1px solid #FF453A30",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#FF453A"}}>
              Go back and select both an account identifier and a balance amount.
            </div>
          )}
          <div style={{background:"var(--card2)",borderRadius:12,padding:14,marginBottom:16}}>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:8,letterSpacing:"1px",textTransform:"uppercase"}}>Preview</div>
            <div style={{lineHeight:2.2}}>
              {tokens.map((tok,i)=>(
                <span key={i} style={{
                  display:"inline-block",margin:"2px",padding:"2px 8px",borderRadius:6,
                  background:i===idTokenIdx?"var(--accent)20":i===balTokenIdx?"var(--positive)20":"transparent",
                  color:i===idTokenIdx?"var(--accent)":i===balTokenIdx?"var(--positive)":"var(--text2)",
                  fontWeight:(i===idTokenIdx||i===balTokenIdx)?700:400,fontSize:13,
                }}>{tok.raw}</span>
              ))}
            </div>
            <div style={{display:"flex",gap:20,marginTop:10,paddingTop:10,borderTop:"1px solid var(--border)"}}>
              <div>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:2}}>Account</div>
                <div style={{fontSize:13,fontWeight:600,color:"var(--accent)"}}>
                  {idType==="last4"?`Last 4 from "${tokens[idTokenIdx]?.raw}"`:`"${tokens[idTokenIdx]?.raw}" → •${mappedLast4}`}
                </div>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:2}}>Balance</div>
                <div style={{fontSize:13,fontWeight:600,color:"var(--positive)"}}>{tokens[balTokenIdx]?.raw}</div>
              </div>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Rule Name</label>
            <input className="form-input" placeholder="e.g. Chase Sapphire"
              value={ruleName} onChange={e=>setRuleName(e.target.value)}/>
          </div>
          <div className="form-group">
            <label className="form-label">Priority</label>
            <div style={{display:"flex",gap:8}}>
              {[{v:"high",l:"High",sub:"Tried before built-in patterns"},{v:"low",l:"Low",sub:"Tried after built-in patterns"}].map(opt=>(
                <button key={opt.v} onClick={()=>setPriority(opt.v)} style={{
                  flex:1,padding:"10px 8px",borderRadius:10,border:"none",cursor:"pointer",
                  fontFamily:"inherit",fontSize:13,fontWeight:600,textAlign:"center",
                  background:priority===opt.v?"var(--accent)":"var(--muted3)",
                  color:priority===opt.v?"#fff":"var(--muted)",transition:"all .15s",
                }}>
                  {opt.v==="high"?"⬆":"⬇"} {opt.l}
                  <div style={{fontSize:10,opacity:0.75,fontWeight:400,marginTop:2}}>{opt.sub}</div>
                </button>
              ))}
            </div>
          </div>
          <button className="form-save-btn" disabled={!ruleName.trim() || idTokenIdx === null || balTokenIdx === null} onClick={handleSave}>
            Save Rule
          </button>
          <button className="form-cancel-btn" onClick={()=>setStep(idType==="keyword"?"map":"balance")}>← Back</button>
        </>}

      </div>
    </div>
  );
}

// ─── Parse Rules Panel (shown in Settings) ────────────────────────────────────

function ParseRulesPanel({ rules, accounts, onAdd, onDelete, onTogglePriority }) {
  const [showBuilder, setShowBuilder] = useState(false);
  return (
    <div style={{margin:"0 16px 24px"}}>
      {rules.length === 0 && (
        <div style={{
          background:"var(--card2)",border:"1px dashed var(--border2)",
          borderRadius:14,padding:18,textAlign:"center",
          color:"var(--muted)",fontSize:13,lineHeight:1.6,marginBottom:10
        }}>
          No custom rules yet.<br/>
          Add one to teach the app your bank's text format.
        </div>
      )}
      {rules.map(rule=>(
        <div key={rule.id} style={{
          background:"var(--card)",borderRadius:14,boxShadow:"var(--card-shadow)",
          padding:"14px 16px",marginBottom:8,
          display:"flex",justifyContent:"space-between",alignItems:"flex-start"
        }}>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:600,color:"var(--text)",marginBottom:3}}>{rule.name}</div>
            <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
              {rule.identifierType==="last4"
                ?`Digits from token ${rule.identifierTokenIndex+1}`
                :`Keyword "${rule.identifierValue}" → •${rule.mappedLast4}`}
              {" · "}Balance from token {rule.balanceTokenIndex+1}
            </div>
            <button onClick={()=>onTogglePriority(rule.id)} style={{
              marginTop:6,padding:"3px 10px",borderRadius:20,border:"none",
              fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:"pointer",
              background:rule.priority==="high"?"var(--accent)20":"var(--muted3)",
              color:rule.priority==="high"?"var(--accent)":"var(--muted)",
            }}>
              {rule.priority==="high"?"⬆ High priority":"⬇ Low priority"}
            </button>
          </div>
          <button onClick={()=>onDelete(rule.id)} style={{
            background:"#FF453A15",color:"#FF453A",border:"none",
            borderRadius:8,padding:"5px 10px",fontFamily:"inherit",
            fontSize:12,fontWeight:600,cursor:"pointer",marginLeft:10,flexShrink:0
          }}>Remove</button>
        </div>
      ))}
      <button onClick={()=>setShowBuilder(true)} style={{
        width:"100%",padding:13,borderRadius:14,
        border:"1.5px dashed var(--border2)",background:"transparent",
        color:"var(--accent)",fontFamily:"inherit",fontSize:14,fontWeight:600,cursor:"pointer"
      }}>
        + Add Parse Rule
      </button>
      {showBuilder && (
        <RuleBuilderModal
          accounts={accounts}
          onSave={rule=>{onAdd(rule);setShowBuilder(false);}}
          onCancel={()=>setShowBuilder(false)}
        />
      )}
    </div>
  );
}

// ─── SpendingScreen (replaces HomeScreen) ────────────────────────────────────

function SpendingScreen({ accounts, snapshots, safeToSpend, residuals, thresholds,
                          thresholdMode, heroKey, smsText, setSmsText, smsResult,
                          onParseSMS, onConfirmCard, manualAcct, setManualAcct,
                          manualBal, setManualBal, onManualSave,
                          latestBalance, firstBalance, dueThresholds }) {

  const spendingBanks = accounts.filter(a => a.role === "spending_bank").sort((a,b)=>(a.incomeRank??99)-(b.incomeRank??99));
  const creditCards   = accounts.filter(a => a.role === "credit_card");
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});

  const primaryStart = spendingBanks[0] ? firstBalance(spendingBanks[0].last4) : null;
  const heroCol = bandColor(safeToSpend, thresholds, thresholdMode, primaryStart);

  const totalBank = spendingBanks.reduce((s,a)=>s+(latestBalance(a.last4)??0),0);
  const totalCards = creditCards.reduce((s,a)=>s+(latestBalance(a.last4)??0),0);

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Safe2Spend</div>
        <div className="header-date">{today}</div>
      </div>

      {/* Hero with ring */}
      <div className="hero">
        <div style={{position:"relative",width:200,height:200,marginBottom:16}}>
          <SafeToSpendRing pct={Math.min(100,Math.max(0,(safeToSpend??0)/Math.max(1,totalBank)*100))} color={heroCol}/>
          <div className="hero-ring-wrap" style={{position:"absolute",top:0,left:0,right:0,bottom:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
            <div className="hero-eyebrow">Safe to spend</div>
            <div key={heroKey} className="hero-amount anim" style={{color:heroCol}}>
              {fmtShort(safeToSpend)}
            </div>
            <div className="hero-sub">
              {safeToSpend === null ? "Add an account"
               : safeToSpend >= 0  ? "after cards"
               : "over limit"}
            </div>
          </div>
        </div>
        <div className="hero-stats" style={{width:"100%",background:"var(--card)",borderRadius:14,boxShadow:"var(--card-shadow)",overflow:"hidden"}}>
          <div className="hero-stat">
            <div className="hero-stat-label">In accounts</div>
            <div className="hero-stat-val">{fmtShort(totalBank)}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-label">On cards</div>
            <div className="hero-stat-val" style={{color:totalCards>0?"#FF9F0A":"var(--text)"}}>{fmtShort(totalCards)}</div>
          </div>
        </div>
      </div>

      {/* Thin waterfall strip */}
      {spendingBanks.length > 0 && totalBank > 0 && (
        <div className="waterfall-strip">
          {spendingBanks.map(a => {
            const bal = latestBalance(a.last4) ?? 0;
            const start = firstBalance(a.last4);
            const res = residuals[a.last4] ?? 0;
            const col = bandColor(res, thresholds, thresholdMode, start);
            return <div key={a.last4} className="waterfall-seg" style={{flex:bal,background:col,opacity:0.85}}/>;
          })}
        </div>
      )}

      <div className="divider"/>

      {/* Spending bank accounts */}
      {spendingBanks.length > 0 && (
        <>
          <div className="section-label">Your Money</div>
          <div className="account-list">
            {spendingBanks.map(a => {
              const bal = latestBalance(a.last4);
              const res = residuals[a.last4] ?? null;
              const start = firstBalance(a.last4);
              const col = bandColor(res, thresholds, thresholdMode, start);
              return (
                <div className={`account-card rank-${a.incomeRank}`} key={a.last4}>
                  <div className="account-card-left">
                    <div style={{width:38,height:38,borderRadius:10,background:RoleColors(a.role).bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <AccountIcon role={a.role} label={a.label}/>
                    </div>
                    <div>
                      <div className="account-label">{a.label}</div>
                      <div className="account-last4">•••• {a.last4}</div>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    {bal !== null
                      ? <div className="account-balance" style={{color:col}}>{fmt(bal)}</div>
                      : <div className="account-balance no-data">No balance</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Credit cards */}
      {creditCards.length > 0 && (
        <>
          <div className="section-label">Credit Cards</div>
          <div className="account-list">
            {creditCards.map(a => {
              const bal = latestBalance(a.last4);
              const days = daysUntilDue(a.dueDay);
              const dateStr = nextDueDateStr(a.dueDay);
              const dc = dueColor(days, dueThresholds);
              return (
                <div className="account-card" key={a.last4}
                  style={{borderLeft: dc ? `3px solid ${dc}` : "1px solid #1A2E4A", paddingLeft: dc ? 15 : 17}}>
                  <div className="account-card-left">
                    <div style={{width:38,height:38,borderRadius:10,background:"#FFF5E6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <AccountIcon role="credit_card" label={a.label}/>
                    </div>
                    <div>
                      <div className="account-label">{a.label}</div>
                      <div className="account-last4">•••• {a.last4}</div>
                      {dateStr
                        ? <span className="rank-badge" style={{background:dc?dc+"20":"var(--border)",color:dc??"var(--muted)",marginTop:4}}>
                            Due {dateStr}{days!==null && ` · ${days}d`}
                          </span>
                        : <span className="rank-badge" style={{background:"var(--border)",color:"var(--muted2)"}}>No due date</span>}
                    </div>
                  </div>
                  {bal !== null
                    ? <div className="account-balance">{fmt(bal)}</div>
                    : <div className="account-balance no-data">No balance</div>}
                </div>
              );
            })}
          </div>
          <div style={{padding:"0 24px",marginBottom:20,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:12,color:"var(--muted)"}}>Total on cards</span>
            <span style={{fontFamily:"'Space Grotesk',monospace",fontSize:14,fontWeight:600,color:"#F5A623"}}>{fmt(totalCards)}</span>
          </div>
        </>
      )}

      {/* SMS Paste */}
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
          value={smsText} onChange={e=>setSmsText(e.target.value)}/>
        <button className="sms-parse-btn" onClick={onParseSMS}>Parse & Save Balance</button>
        {smsResult && smsResult.ok === "confirm" ? (
          <div className="sms-result" style={{background:"#9B88FF14",color:"var(--text2)"}}>
            <div style={{marginBottom:10}}>{smsResult.msg}</div>
            <select className="select-input" style={{marginBottom:8}} defaultValue=""
              onChange={e=>e.target.value&&onConfirmCard(e.target.value,smsResult.balance)}>
              <option value="" disabled>Select account…</option>
              {accounts.map(a=><option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>)}
            </select>
          </div>
        ) : smsResult ? (
          <div className={`sms-result ${smsResult.ok?"success":"error"}`}>{smsResult.msg}</div>
        ) : null}
      </div>

      {/* Manual entry */}
      <div className="section-label">Manual Entry</div>
      <div className="manual-panel">
        <div className="manual-title">Enter Balance Manually</div>
        <select className="select-input" value={manualAcct} onChange={e=>setManualAcct(e.target.value)}>
          <option value="">Select account…</option>
          {accounts.map(a=><option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>)}
        </select>
        <div className="input-row">
          <input className="text-input" placeholder="0.00" value={manualBal}
            onChange={e=>setManualBal(e.target.value)} type="number" inputMode="decimal"/>
          <button className="add-btn" onClick={onManualSave}>Save</button>
        </div>
      </div>
    </div>
  );
}


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


// ─── Export / Import Engine ───────────────────────────────────────────────────

// Column headers — widest record type wins (Bills has most columns)
const CSV_HEADERS = [
  "Type","id","last4","label","role","rank","dueDay","floatEnabled","floatMultiplier",
  "balance","timestamp","source",
  "name","amount","frequency","myPct","theirPct","fundingAcct","paymentAcct",
  "creditCard","isFixed","isAutopay","isEF","isRetire","rewardMult","notes",
  "netPay","nextPayDate","status","completedAt",
  "current","goal","targetType","targetDate","targetAge",
  "hi","mid","lo","mode","threshType"
];

function escapeCSV(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCSV(obj) {
  return CSV_HEADERS.map(h => escapeCSV(obj[h] ?? "")).join(",");
}

function buildExportRows(accounts, snapshots, bills, paycheck, billsOverride,
                          roadmap, investments, thresholds, thresholdMode,
                          dueThresholds, investThresholds) {
  const rows = [];

  // ACCOUNTS
  accounts.forEach(a => {
    rows.push({
      Type:"ACCOUNT", last4:a.last4, label:a.label, role:a.role,
      rank:a.incomeRank??"", dueDay:a.dueDay??"",
      floatEnabled:a.floatEnabled??"", floatMultiplier:a.floatMultiplier??""
    });
  });

  // SNAPSHOTS — only most recent per account
  const latestSnaps = {};
  snapshots.forEach(s => {
    const existing = latestSnaps[s.accountLast4];
    if (!existing || new Date(s.timestamp) > new Date(existing.timestamp)) {
      latestSnaps[s.accountLast4] = s;
    }
  });
  Object.values(latestSnaps).forEach(s => {
    rows.push({
      Type:"SNAPSHOT", last4:s.accountLast4, balance:s.balance,
      timestamp:s.timestamp, source:s.source
    });
  });

  // BILLS
  bills.forEach(b => {
    rows.push({
      Type:"BILL", id:b.id, name:b.name, amount:b.amount,
      frequency:b.frequency, myPct:b.myPct, theirPct:b.theirPct,
      fundingAcct:b.fundingAcct, paymentAcct:b.paymentAcct,
      creditCard:b.creditCard, dueDay:b.dueDay??"",
      isFixed:b.isFixed, isAutopay:b.isAutopay,
      isEF:b.isEF, isRetire:b.isRetire,
      rewardMult:b.rewardMult, notes:b.notes
    });
  });

  // PAYCHECK
  rows.push({
    Type:"PAYCHECK", netPay:paycheck?.netPay??"", frequency:paycheck?.frequency??"",
    nextPayDate:paycheck?.nextPayDate??""
  });

  // BILLS_OVERRIDE (pay settings override on Bills tab)
  if (billsOverride) {
    rows.push({
      Type:"BILLS_OVERRIDE", netPay:billsOverride.netPay??"",
      frequency:billsOverride.frequency??"", nextPayDate:billsOverride.nextPayDate??""
    });
  }

  // ROADMAP
  roadmap.forEach(r => {
    rows.push({
      Type:"ROADMAP", id:r.id, name:r.label,
      status:r.status, completedAt:r.completedAt??""
    });
  });

  // INVESTMENTS
  investments.forEach(inv => {
    rows.push({
      Type:"INVEST", id:inv.id, name:inv.name,
      current:inv.current, goal:inv.goal,
      targetType:inv.targetType, targetDate:inv.targetDate??"",
      targetAge:inv.targetAge??"", notes:inv.notes??""
    });
  });

  // THRESHOLDS
  rows.push({ Type:"THRESHOLD", threshType:"spending", hi:thresholds?.hi,         mid:thresholds?.mid,         lo:thresholds?.lo,         mode:thresholdMode||"percent" });
  rows.push({ Type:"THRESHOLD", threshType:"due",      hi:dueThresholds?.green,    mid:dueThresholds?.yellow,   lo:dueThresholds?.red,     mode:"days" });
  rows.push({ Type:"THRESHOLD", threshType:"invest",   hi:investThresholds?.green, mid:investThresholds?.yellow,lo:investThresholds?.red,  mode:"percent" });

  return rows;
}

function exportToCSV(args) {
  const rows = buildExportRows(...args);
  const header = CSV_HEADERS.join(",");
  const body   = rows.map(rowToCSV).join("\n");
  const csv    = header + "\n" + body;
  const blob   = new Blob([csv], { type:"text/csv;charset=utf-8;" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = `safe2spend_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Parse uploaded file (CSV or XLSX via SheetJS) ─────────────────────────────

function parseCSVText(text) {
  // Simple CSV parser that handles quoted fields
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] ?? "").trim(); });
    return obj;
  }).filter(r => r.Type);
}

function parseCSVLine(line) {
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      result.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseBool(v) {
  if (v === "" || v === undefined || v === null) return undefined;
  return v === "true" || v === "TRUE" || v === "1";
}

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function importFromRows(rows, callbacks) {
  const {
    setAccounts, setSnapshots, setBills, setPaycheck,
    setBillsOverride, setRoadmap, setInvestments,
    setThresholds, setThresholdMode, setDueThresholds, setInvestThresholds
  } = callbacks;

  // Group rows by type
  const byType = {};
  rows.forEach(r => {
    const t = r.Type?.trim().toUpperCase();
    if (!t) return;
    if (!byType[t]) byType[t] = [];
    byType[t].push(r);
  });

  // ACCOUNTS
  if (byType.ACCOUNT) {
    const accounts = byType.ACCOUNT.map((r, i) => ({
      last4:        r.last4?.trim(),
      label:        r.label?.trim() || "Account",
      role:         r.role?.trim()  || "spending_bank",
      incomeRank:   r.rank !== "" ? parseInt(r.rank) : null,
      dueDay:       r.dueDay !== "" ? parseInt(r.dueDay) : null,
      floatEnabled: r.floatEnabled !== "" ? parseBool(r.floatEnabled) : undefined,
      floatMultiplier: r.floatMultiplier !== "" ? parseNum(r.floatMultiplier) : undefined,
    })).filter(a => a.last4);
    setAccounts(accounts);
  }

  // SNAPSHOTS
  if (byType.SNAPSHOT) {
    const snaps = byType.SNAPSHOT.map((r, i) => ({
      id:           Date.now() + i,
      accountLast4: r.last4?.trim(),
      balance:      parseNum(r.balance) ?? 0,
      timestamp:    r.timestamp?.trim() || new Date().toISOString(),
      source:       r.source?.trim() || "manual",
    })).filter(s => s.accountLast4);
    setSnapshots(snaps);
  }

  // BILLS
  if (byType.BILL) {
    const bills = byType.BILL.map(r => ({
      id:          parseNum(r.id) || Date.now(),
      name:        r.name?.trim() || "",
      amount:      r.amount?.trim() || "",
      frequency:   r.frequency?.trim() || "monthly",
      myPct:       r.myPct?.trim() || "100",
      theirPct:    r.theirPct?.trim() || "0",
      fundingAcct: r.fundingAcct?.trim() || "",
      paymentAcct: r.paymentAcct?.trim() || "",
      creditCard:  r.creditCard?.trim() || "",
      dueDay:      r.dueDay !== "" ? parseInt(r.dueDay) : null,
      isFixed:     parseBool(r.isFixed) ?? true,
      isAutopay:   parseBool(r.isAutopay) ?? false,
      isEF:        parseBool(r.isEF) ?? false,
      isRetire:    parseBool(r.isRetire) ?? false,
      rewardMult:  r.rewardMult?.trim() || "",
      notes:       r.notes?.trim() || "",
    }));
    setBills(bills);
  }

  // PAYCHECK
  if (byType.PAYCHECK?.[0]) {
    const r = byType.PAYCHECK[0];
    setPaycheck({ netPay: r.netPay?.trim() || "", frequency: r.frequency?.trim() || "biweekly", nextPayDate: r.nextPayDate?.trim() || "" });
  }

  // BILLS_OVERRIDE
  if (byType.BILLS_OVERRIDE?.[0]) {
    const r = byType.BILLS_OVERRIDE[0];
    setBillsOverride({ netPay: r.netPay?.trim() || "", frequency: r.frequency?.trim() || "biweekly", nextPayDate: r.nextPayDate?.trim() || "" });
  }

  // ROADMAP
  if (byType.ROADMAP) {
    const roadmap = byType.ROADMAP.map(r => ({
      id:          parseNum(r.id) || Date.now(),
      label:       r.name?.trim() || "",
      status:      r.status?.trim() || "future",
      completedAt: r.completedAt?.trim() || undefined,
    }));
    setRoadmap(roadmap);
  }

  // INVESTMENTS
  if (byType.INVEST) {
    const investments = byType.INVEST.map(r => ({
      id:         parseNum(r.id) || Date.now(),
      name:       r.name?.trim() || "",
      current:    r.current?.trim() || "",
      goal:       r.goal?.trim() || "",
      targetType: r.targetType?.trim() || "date",
      targetDate: r.targetDate?.trim() || "",
      targetAge:  r.targetAge?.trim() || "",
      notes:      r.notes?.trim() || "",
    }));
    setInvestments(investments);
  }

  // THRESHOLDS
  if (byType.THRESHOLD) {
    byType.THRESHOLD.forEach(r => {
      const t = r.threshType?.trim().toLowerCase();
      if (t === "spending") {
        setThresholds({ hi: r.hi, mid: r.mid, lo: r.lo });
        setThresholdMode(r.mode?.trim() || "percent");
      } else if (t === "due") {
        setDueThresholds({ green: r.hi, yellow: r.mid, red: r.lo });
      } else if (t === "invest") {
        setInvestThresholds({ green: r.hi, yellow: r.mid, red: r.lo });
      }
    });
  }
}

// ── ExportImport UI component ─────────────────────────────────────────────────

function ExportImportPanel({ exportArgs, importCallbacks, showToast }) {
  const [importing, setImporting]   = useState(false);
  const [importMsg, setImportMsg]   = useState(null);
  const fileRef = useRef();

  function handleExport() {
    try {
      exportToCSV(exportArgs);
      showToast("Exported — check your downloads");
    } catch(e) {
      showToast("Export failed");
      console.error(e);
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "csv") {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const rows = parseCSVText(ev.target.result);
          importFromRows(rows, importCallbacks);
          setImportMsg({ ok:true, msg:`Imported ${rows.length} rows. App updated.` });
          showToast("Data imported ✓");
        } catch(err) {
          setImportMsg({ ok:false, msg:"Failed to parse CSV: " + err.message });
        }
        setImporting(false);
        e.target.value = "";
      };
      reader.readAsText(file);
    } else if (ext === "xlsx" || ext === "xls") {
      // SheetJS loaded via <script> tag in index.html — available as window.XLSX
      if (!window.XLSX) {
        setImportMsg({ ok:false, msg:"XLSX library not loaded yet. Try again in a moment." });
        setImporting(false);
        return;
      }
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const XLSX = window.XLSX;
          const wb   = XLSX.read(ev.target.result, { type:"array" });
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { defval:"" });
          importFromRows(data, importCallbacks);
          setImportMsg({ ok:true, msg:`Imported ${data.length} rows from ${file.name}.` });
          showToast("Data imported ✓");
          setImporting(false);
          e.target.value = "";
        } catch(err) {
          setImportMsg({ ok:false, msg:"Failed to parse XLSX: " + err.message });
          setImporting(false);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setImportMsg({ ok:false, msg:"Please upload a .csv or .xlsx file." });
      setImporting(false);
    }
  }

  return (
    <div style={{background:"var(--card2)",border:"1px solid var(--border2)",borderRadius:14,padding:18,margin:"0 16px 24px"}}>
      <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:14}}>
        Export / Import
      </div>

      {/* Export */}
      <button onClick={handleExport} style={{
        width:"100%",padding:"12px 16px",borderRadius:10,border:"none",
        background:"var(--positive)",color:"var(--bg)",fontFamily:"'DM Sans',sans-serif",
        fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:10,textAlign:"left"
      }}>
        ↓ Export to CSV
      </button>
      <div style={{fontSize:11,color:"var(--muted2)",marginBottom:16,lineHeight:1.5}}>
        Downloads all your data as a .csv file. Open in Excel or Google Sheets to edit, then re-upload below.
      </div>

      {/* Import */}
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls"
        style={{display:"none"}} onChange={handleFileChange}/>
      <button onClick={()=>fileRef.current?.click()} disabled={importing} style={{
        width:"100%",padding:"12px 16px",borderRadius:10,border:"1px solid var(--border2)",
        background:"var(--border)",color:"var(--text2)",fontFamily:"'DM Sans',sans-serif",
        fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:6,textAlign:"left",
        opacity:importing?0.6:1
      }}>
        {importing ? "Importing…" : "↑ Import CSV or XLSX"}
      </button>
      <div style={{fontSize:11,color:"var(--muted2)",marginBottom:importMsg?10:0,lineHeight:1.5}}>
        Replaces all current data. Export first as a backup before importing.
      </div>

      {importMsg && (
        <div style={{
          padding:"10px 12px",borderRadius:8,fontSize:12,marginTop:4,
          background: importMsg.ok ? "#00D4AA12" : "#FF6B6B12",
          color:      importMsg.ok ? "#00D4AA"   : "#FF6B6B"
        }}>
          {importMsg.msg}
        </div>
      )}
    </div>
  );
}


function SettingsScreen({ thresholds, thresholdMode,
                          dueThresholds, investThresholds,
                          onSaveThresholds, onSaveThresholdMode,
                          onSaveDueThresholds, onSaveInvestThresholds,
                          snapshots, accounts, bills, paycheck, billsOverride,
                          roadmap, investments,
                          setAccounts, setSnapshots, setBills, setPaycheck,
                          setBillsOverride, setRoadmap, setInvestments,
                          setThresholds, setThresholdMode,
                          setDueThresholds, setInvestThresholds,
                          showToast, theme, onSetTheme, parseRules,
                          onAddParseRule, onDeleteParseRule, onToggleParseRulePriority }) {
  const [tHi,  setTHi]  = useState(thresholds?.hi  ?? "60");
  const [tMid, setTMid] = useState(thresholds?.mid ?? "30");
  const [tLo,  setTLo]  = useState(thresholds?.lo  ?? "15");
  const [tMode, setTMode] = useState(thresholdMode ?? "percent");
  const [dGreen,  setDGreen]  = useState(dueThresholds?.green  ?? "14");
  const [dYellow, setDYellow] = useState(dueThresholds?.yellow ?? "7");
  const [dRed,    setDRed]    = useState(dueThresholds?.red    ?? "3");
  const [iGreen,  setIGreen]  = useState(investThresholds?.green  ?? "75");
  const [iYellow, setIYellow] = useState(investThresholds?.yellow ?? "40");
  const [iRed,    setIRed]    = useState(investThresholds?.red    ?? "10");

  function handleSave() {
    onSaveThresholds?.({ hi: tHi, mid: tMid, lo: tLo });
    onSaveThresholdMode?.(tMode);
    onSaveDueThresholds?.({ green: dGreen, yellow: dYellow, red: dRed });
    onSaveInvestThresholds?.({ green: iGreen, yellow: iYellow, red: iRed });
  }

  const unit = tMode === "percent" ? "%" : "$";
  const placeholder = tMode === "percent"
    ? ["e.g. 60", "e.g. 30", "e.g. 15"]
    : ["e.g. 2000", "e.g. 1000", "e.g. 500"];

  if (!thresholds || !dueThresholds || !investThresholds) {
    return (
      <div className="screen">
        <div className="screen-title">Settings</div>
        <div style={{padding:24,color:"var(--muted)",fontSize:14}}>Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="screen-title">Settings</div>

      {/* ── Theme ── */}
      <div className="section-label">Theme</div>
      <div style={{padding:"0 16px",marginBottom:24}}>
        <div style={{display:"flex",gap:8}}>
          {[
            { id:"dark",  label:"Dark",  dot:"#0F172A" },
            { id:"light", label:"Light", dot:"#F5F7FA" },
            { id:"warm",  label:"Warm",  dot:"#FAF7F2" },
          ].map(t=>(
            <button key={t.id} onClick={()=>onSetTheme(t.id)} style={{
              flex:1, padding:"12px 8px", borderRadius:12, cursor:"pointer",
              border: theme===t.id ? "2px solid var(--accent)" : "2px solid var(--border)",
              background: theme===t.id ? "var(--card2)" : "var(--card)",
              display:"flex", flexDirection:"column", alignItems:"center", gap:8,
              fontFamily:"'DM Sans',sans-serif", transition:"all .15s"
            }}>
              <div style={{
                width:32, height:32, borderRadius:"50%",
                background:t.dot, border:"2px solid var(--border)",
                boxShadow: theme===t.id ? "0 0 0 2px var(--accent)" : "none"
              }}/>
              <span style={{fontSize:12,fontWeight:600,color:theme===t.id?"var(--accent)":"var(--muted)"}}>
                {t.label}
              </span>
            </button>
          ))}
        </div>
      </div>

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
          { color:"var(--positive)", label:"Above this →", val:tHi, set:setTHi, ph:placeholder[0] },
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
        <div style={{ fontSize:11, color:"var(--muted2)", marginBottom:12, paddingLeft:22 }}>Below the last level shows red.</div>
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
          { color:"var(--positive)", val:dGreen,  set:setDGreen,  ph:"e.g. 14" },
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
        <div style={{ fontSize:11, color:"var(--muted2)", marginBottom:12, paddingLeft:22 }}>
          Below the last level shows red. Changes save with the "Save levels" button above.
        </div>
      </div>

      {/* ── Income Accounts (ordered) ── */}
      {/* ── Investment Color Thresholds ── */}
      <div className="section-label">Investment Goal Colors</div>
      <div className="threshold-panel">
        <div className="threshold-title">% of Goal</div>
        <div className="threshold-hint">
          Colors the investment tab hero number based on overall progress toward your total goal.
        </div>
        <div className="band-preview">
          {["#00D4AA","#F5C842","#F5A623","#FF6B6B"].map(c=><div key={c} className="band-seg" style={{background:c}}/>)}
        </div>
        {[
          {color:"var(--positive)",val:iGreen, set:setIGreen, ph:"e.g. 75"},
          {color:"#F5C842",val:iYellow,set:setIYellow,ph:"e.g. 40"},
          {color:"#F5A623",val:iRed,   set:setIRed,   ph:"e.g. 10"},
        ].map(({color,val,set,ph})=>(
          <div className="threshold-row" key={color}>
            <div className="threshold-swatch" style={{background:color}}/>
            <input className="threshold-input" placeholder={ph} value={val}
              onChange={e=>set(e.target.value)} type="number" inputMode="decimal"/>
            <span className="threshold-unit">%</span>
          </div>
        ))}
        <div style={{fontSize:11,color:"var(--muted2)",marginBottom:12,paddingLeft:22}}>Below the last level shows red.</div>
        <button className="threshold-save" onClick={handleSave}>Save all</button>
      </div>

      {/* Balance History */}
      <div className="section-label">Balance History</div>
      <div className="history-section">
        {!snapshots || snapshots.length === 0
          ? <div className="history-empty" style={{padding:"24px 0"}}>No history yet.</div>
          : [...snapshots].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).map(s => {
              const acct = accounts && accounts.find(ac => ac.last4 === s.accountLast4);
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
            })
        }
      </div>

      <div className="section-label">Parse Rules</div>
      <ParseRulesPanel
        rules={parseRules}
        accounts={accounts}
        onAdd={onAddParseRule}
        onDelete={onDeleteParseRule}
        onTogglePriority={onToggleParseRulePriority}
      />

      <div className="section-label">Data</div>
      <ExportImportPanel
        exportArgs={[accounts||[], snapshots||[], bills||[], paycheck||{}, billsOverride||null,
                     roadmap||[], investments||[], thresholds||{}, thresholdMode||"percent",
                     dueThresholds||{}, investThresholds||{}]}
        importCallbacks={{
          setAccounts:        v => { save("s2s_accounts",       v); setAccounts(v); },
          setSnapshots:       v => { save("s2s_snapshots",      v); setSnapshots(v); },
          setBills:           v => { save("s2s_bills",          v); setBills(v); },
          setPaycheck:        v => { save("s2s_paycheck",       v); setPaycheck(v); },
          setBillsOverride:   v => { save("s2s_bills_override", v); setBillsOverride(v); },
          setRoadmap:         v => { save("s2s_roadmap",        v); setRoadmap(v); },
          setInvestments:     v => { save("s2s_investments",    v); setInvestments(v); },
          setThresholds:      v => { save("s2s_thresholds",     v); setThresholds(v); },
          setThresholdMode:   v => { save("s2s_tmode",          v); setThresholdMode(v); },
          setDueThresholds:   v => { save("s2s_due_thr",        v); setDueThresholds(v); },
          setInvestThresholds:v => { save("s2s_inv_thr",        v); setInvestThresholds(v); },
        }}
        showToast={showToast}
      />
      <div className="section-label">About</div>
      <div className="settings-section">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Safe2Spend</div>
            <div className="settings-row-sub">v0.8 · 4 account roles · Bills scale · Swipe nav</div>
          </div>
        </div>
        <div className="settings-row" style={{flexDirection:"column",alignItems:"stretch",gap:8}}>
          <div className="settings-row-label">Reset to Sample Data</div>
          <div className="settings-row-sub">Clears all saved data and reloads the app with fresh sample accounts, bills, and history.</div>
          <button onClick={resetAllData}
            style={{marginTop:4,padding:"10px 16px",borderRadius:10,border:"none",
              background:"#FF6B6B18",color:"#FF6B6B",fontFamily:"'DM Sans',sans-serif",
              fontSize:13,fontWeight:600,cursor:"pointer",textAlign:"left"}}>
            Reset App Data
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard Character ─────────────────────────────────────────────────────
// Minimal flat Apple-ish illustration; scene changes with milestone progress

function CharacterScene({ doneCount, totalSteps, currentStep }) {
  const pct = totalSteps > 0 ? doneCount / totalSteps : 0;

  // Scene 0-2 done: person at a desk, looking at phone (just starting out)
  // Scene 3-5 done: person in a car, driving (momentum)
  // Scene 6-9 done: person climbing a mountain (building wealth)
  // Scene 10+  done: person at summit with flag (thriving)

  const scene = doneCount <= 2 ? "desk" : doneCount <= 5 ? "car" : doneCount <= 9 ? "mountain" : "summit";

  const scenes = {
    desk: {
      label: "Getting started",
      color: "#9B88FF",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          {/* desk */}
          <rect x="30" y="82" width="160" height="8" rx="3" fill="var(--border)"/>
          <rect x="50" y="90" width="6" height="22" rx="2" fill="var(--border)"/>
          <rect x="164" y="90" width="6" height="22" rx="2" fill="var(--border)"/>
          {/* laptop */}
          <rect x="80" y="62" width="60" height="38" rx="4" fill="var(--bg2)" stroke="var(--muted2)" strokeWidth="1.5"/>
          <rect x="84" y="66" width="52" height="29" rx="2" fill="var(--card)"/>
          {/* screen glow lines */}
          <rect x="88" y="70" width="30" height="2" rx="1" fill="#9B88FF" opacity="0.6"/>
          <rect x="88" y="75" width="22" height="2" rx="1" fill="#9B88FF" opacity="0.4"/>
          <rect x="88" y="80" width="26" height="2" rx="1" fill="#00D4AA" opacity="0.5"/>
          <rect x="68" y="100" width="84" height="4" rx="2" fill="var(--border)"/>
          {/* person */}
          <circle cx="52" cy="54" r="12" fill="#F5A623"/>
          <rect x="40" y="68" width="24" height="20" rx="4" fill="#9B88FF"/>
          {/* arm reaching to laptop */}
          <path d="M64 74 Q72 74 78 70" stroke="#F5A623" strokeWidth="3.5" strokeLinecap="round"/>
          {/* coffee */}
          <rect x="152" y="72" width="14" height="14" rx="3" fill="var(--border)" stroke="var(--muted2)" strokeWidth="1"/>
          <path d="M155 68 Q157 64 159 68" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    },
    car: {
      label: "Building momentum",
      color: "#F5C842",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          {/* road */}
          <rect x="0" y="90" width="220" height="30" fill="var(--bg2)"/>
          <rect x="0" y="88" width="220" height="4" fill="var(--border)"/>
          {/* road dashes */}
          {[10,50,90,130,170].map(x=><rect key={x} x={x} y="103" width="24" height="3" rx="1.5" fill="var(--muted2)"/>)}
          {/* car body */}
          <rect x="40" y="68" width="130" height="32" rx="8" fill="#9B88FF"/>
          {/* car top */}
          <path d="M70 68 Q80 44 100 42 L140 42 Q158 44 160 68Z" fill="#7B68EE"/>
          {/* windows */}
          <rect x="82" y="48" width="30" height="18" rx="3" fill="var(--text2)" opacity="0.3"/>
          <rect x="118" y="48" width="30" height="18" rx="3" fill="var(--text2)" opacity="0.3"/>
          {/* wheels */}
          <circle cx="78" cy="100" r="12" fill="var(--bg)" stroke="var(--muted2)" strokeWidth="2"/>
          <circle cx="78" cy="100" r="5" fill="var(--border)"/>
          <circle cx="148" cy="100" r="12" fill="var(--bg)" stroke="var(--muted2)" strokeWidth="2"/>
          <circle cx="148" cy="100" r="5" fill="var(--border)"/>
          {/* headlights */}
          <ellipse cx="170" cy="80" rx="5" ry="4" fill="#F5C842" opacity="0.8"/>
          <path d="M175 78 L195 72 M175 82 L195 88" stroke="#F5C842" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
          {/* person in car */}
          <circle cx="110" cy="56" r="9" fill="#F5A623"/>
          {/* speed lines */}
          {[20,30,40].map((y,i)=>(
            <line key={i} x1={10} y1={y+50} x2={30} y2={y+50} stroke="var(--muted2)" strokeWidth="1.5" strokeLinecap="round" opacity={0.3+i*0.2}/>
          ))}
        </svg>
      )
    },
    mountain: {
      label: "Climbing higher",
      color: "var(--positive)",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          {/* sky gradient suggestion */}
          <rect x="0" y="0" width="220" height="120" fill="var(--bg)"/>
          {/* mountain far */}
          <path d="M0 120 L60 40 L120 120Z" fill="var(--card)"/>
          {/* mountain near */}
          <path d="M60 120 L140 20 L220 120Z" fill="var(--bg2)"/>
          {/* snow cap */}
          <path d="M130 36 L140 20 L150 36 Q140 32 130 36Z" fill="var(--text2)" opacity="0.3"/>
          {/* path up mountain */}
          <path d="M80 120 Q100 90 115 60 Q125 40 140 20" stroke="var(--muted2)" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round"/>
          {/* person climbing */}
          <circle cx="112" cy="65" r="9" fill="#F5A623"/>
          <rect x="105" y="75" width="14" height="16" rx="3" fill="#00D4AA"/>
          {/* arm with axe/pole */}
          <line x1="119" y1="77" x2="128" y2="65" stroke="#F5A623" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="128" y1="65" x2="128" y2="55" stroke="var(--text2)" strokeWidth="1.5" strokeLinecap="round"/>
          {/* stars */}
          {[[185,15],[195,30],[175,25],[200,10]].map(([x,y],i)=>(
            <circle key={i} cx={x} cy={y} r="1.5" fill="var(--muted)" opacity={0.6}/>
          ))}
        </svg>
      )
    },
    summit: {
      label: "At the summit",
      color: "var(--positive)",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          <rect x="0" y="0" width="220" height="120" fill="var(--bg)"/>
          {/* mountains background */}
          <path d="M0 120 L50 55 L100 120Z" fill="var(--card)"/>
          <path d="M90 120 L150 30 L210 120Z" fill="var(--bg2)"/>
          <path d="M140 48 L150 30 L160 48 Q150 44 140 48Z" fill="var(--text2)" opacity="0.4"/>
          {/* sunrise rays */}
          {[0,30,60,90,120,150,180,210,240,270,300,330].map((deg,i)=>(
            <line key={i}
              x1={110} y1={30}
              x2={110 + Math.cos(deg*Math.PI/180)*40}
              y2={30  + Math.sin(deg*Math.PI/180)*40}
              stroke="#F5C842" strokeWidth="1" opacity={0.15}/>
          ))}
          <circle cx="110" cy="30" r="14" fill="#F5C842" opacity="0.15"/>
          <circle cx="110" cy="30" r="8"  fill="#F5C842" opacity="0.4"/>
          {/* person at summit */}
          <circle cx="150" cy="48" r="9" fill="#F5A623"/>
          <rect x="143" y="58" width="14" height="16" rx="3" fill="#00D4AA"/>
          {/* flag */}
          <line x1="157" y1="55" x2="157" y2="30" stroke="var(--text2)" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M157 30 L172 35 L157 40Z" fill="#00D4AA"/>
          {/* arms up */}
          <line x1="143" y1="62" x2="134" y2="52" stroke="#F5A623" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="157" y1="62" x2="163" y2="52" stroke="#F5A623" strokeWidth="2.5" strokeLinecap="round"/>
          {/* sparkles */}
          {[[130,25],[175,20],[185,45],[120,42]].map(([x,y],i)=>(
            <g key={i}>
              <line x1={x} y1={y-4} x2={x} y2={y+4} stroke="#00D4AA" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
              <line x1={x-4} y1={y} x2={x+4} y2={y} stroke="#00D4AA" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
            </g>
          ))}
        </svg>
      )
    }
  };

  const s = scenes[scene];
  return (
    <div style={{
      background:"var(--card)", border:`1px solid ${s.color}20`,
      borderRadius:16, padding:"20px 20px 16px", margin:"0 16px 16px",
      textAlign:"center"
    }}>
      <div style={{marginBottom:12}}>{s.svg}</div>
      <div style={{fontSize:11,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:s.color,marginBottom:4}}>
        {s.label}
      </div>
      {currentStep && (
        <div style={{fontSize:13,color:"var(--text2)"}}>
          Working toward: <strong>{currentStep.label}</strong>
        </div>
      )}
      <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>
        {doneCount} of {totalSteps} milestones complete
      </div>
    </div>
  );
}

// ─── DashboardScreen ──────────────────────────────────────────────────────────

function DashboardScreen({ safeToSpend, thresholds, thresholdMode, firstBalance,
                           accounts, bills, paycheck, roadmap, snapshots, latestBalance, dueThresholds, billsOverride }) {
  const incomeAccts  = accounts.filter(a => a.role === "spending_bank").sort((a,b) => a.incomeRank - b.incomeRank);
  const spendingAccts = accounts.filter(a => a.role === "credit_card");

  // Projected safe to spend from paycheck planner
  const freq = paycheck.frequency || "biweekly";
  const FREQ_PER_YEAR = { weekly:52, biweekly:26, semimonthly:24, monthly:12 };
  const perYear = FREQ_PER_YEAR[freq] || 26;
  const netPay = parseFloat(paycheck.netPay) || 0;
  function reservePerPaycheck(bill) {
    const BILL_FREQ = { weekly:52, biweekly:26, semimonthly:24, monthly:12, quarterly:4, annual:1, onetime:0 };
    const myPct = parseFloat(bill.myPct) || 100;
    const annual = (parseFloat(bill.amount) || 0) * (BILL_FREQ[bill.frequency] || 12) * (myPct / 100);
    return annual / perYear;
  }
  const totalReserve = bills.reduce((s, b) => s + reservePerPaycheck(b), 0);
  const projectedSafe = netPay - totalReserve;

  // Current roadmap step
  const currentStep = roadmap.find(s => s.status === "current");
  const doneSteps   = roadmap.filter(s => s.status === "done").length;
  const nextStep    = roadmap.find(s => s.status === "future");

  // Upcoming bills (next 14 days)
  const today = new Date();
  const upcoming = spendingAccts
    .filter(a => a.dueDay)
    .map(a => {
      const days = daysUntilDue(a.dueDay);
      const bal  = latestBalance(a.last4);
      return { ...a, days, bal };
    })
    .filter(a => a.days !== null && a.days <= 14)
    .sort((a,b) => a.days - b.days);

  // Float status
  const monthlyBillsByAcct = {};
  bills.forEach(b => {
    const BILL_FREQ = { weekly:52, biweekly:26, semimonthly:24, monthly:12, quarterly:4, annual:1, onetime:0 };
    const monthly = (parseFloat(b.amount) || 0) * ((BILL_FREQ[b.frequency] || 12) / 12);
    const acct = b.paymentAcct;
    if (acct) monthlyBillsByAcct[acct] = (monthlyBillsByAcct[acct] || 0) + monthly;
  });

  const primaryAcct = incomeAccts[0];
  const primaryBal  = primaryAcct ? latestBalance(primaryAcct.last4) : null;
  const primaryStart = primaryAcct ? firstBalance(primaryAcct.last4) : null;
  const heroCol = bandColor(safeToSpend, thresholds, thresholdMode, primaryStart);
  const today2 = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Dashboard</div>
        <div className="header-date">{today2}</div>
      </div>

      {/* Projected surplus suggestion */}
      {projectedSafe > 0 && currentStep && (
        <div className="suggest-card">
          <div className="suggest-label">Projected Surplus</div>
          <div className="suggest-title">{fmtShort(projectedSafe)} extra this paycheck</div>
          <div className="suggest-reason">
            Consider putting it toward: <strong style={{color:"var(--text)"}}>{currentStep.label}</strong>
          </div>
        </div>
      )}

      {/* Character scene */}
      <CharacterScene doneCount={doneSteps} totalSteps={roadmap.length} currentStep={currentStep}/>

      <div className="dash-grid">

        {/* Safe to Spend */}
        <div className="dash-card">
          <div className="dash-card-label">Safe to Spend</div>
          <div className="dash-card-value" style={{color: heroCol}}>{fmtShort(safeToSpend)}</div>
          <div className="dash-card-sub">Based on current balances</div>
        </div>

        {/* Next paycheck */}
        {(() => {
          const cycleLen = PAY_CYCLE_DAYS[billsOverride?.frequency ?? freq] || 14;
          const resolvedPay = resolveNextPayDate(billsOverride?.nextPayDate ?? paycheck.nextPayDate, cycleLen);
          const daysToPay = resolvedPay ? daysUntilDate(resolvedPay.toISOString().slice(0,10)) : null;
          return (
            <div className="dash-row">
              <div className="dash-card dash-half small">
                <div className="dash-card-label">Next Paycheck</div>
                <div className="dash-card-value">{fmtShort(netPay)}</div>
                <div className="dash-card-sub">
                  {resolvedPay ? `${fmtDateShort(resolvedPay)}${daysToPay!==null?` · ${daysToPay}d`:""}` : freq}
                </div>
              </div>
              <div className="dash-card dash-half small">
                <div className="dash-card-label">Reserved</div>
                <div className="dash-card-value" style={{color:"#F5A623"}}>{fmtShort(totalReserve)}</div>
                <div className="dash-card-sub">for bills</div>
              </div>
            </div>
          );
        })()}
        {/* Trough insight card */}
        {(() => {
          const billsBanks = accounts.filter(a=>a.role==="bills_bank");
          const totalBillsBal = billsBanks.reduce((s,a)=>s+(latestBalance(a.last4)??0),0);
          if (!billsBanks.length || !netPay) return null;
          const sim = runTroughSimulation({
            bills, totalBillsBal,
            netPay: billsOverride?.netPay ?? netPay,
            frequency: billsOverride?.frequency ?? freq,
            floatMult: billsBanks[0]?.floatMultiplier ?? 1.5,
            accounts,
            nextPayDate: billsOverride?.nextPayDate ?? paycheck.nextPayDate,
          });
          const verdictCol = sim.isSafeUntilPaycheck ? "#00D4AA" : "#FF6B6B";
          return (
            <div className="dash-card" style={{borderColor: verdictCol+"30"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                <span style={{fontSize:14}}>{sim.isSafeUntilPaycheck ? "✅" : "⚠️"}</span>
                <div className="dash-card-label" style={{marginBottom:0}}>
                  {sim.isSafeUntilPaycheck ? "Bills Account · Safe until payday" : "Bills Account · At risk before payday"}
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginTop:8}}>
                <div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>Hits $0 (no deposits)</div>
                  <div className="dash-card-value" style={{fontSize:22,color:sim.zeroCrossDate?"#FF6B6B":"var(--positive)"}}>
                    {sim.zeroCrossDateStr || "Never"}
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>Next paycheck</div>
                  <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:"var(--text)"}}>
                    {sim.nextPaycheckDateStr || "Not set"}
                  </div>
                </div>
              </div>
              {sim.isSafeUntilPaycheck ? (
                <div style={{marginTop:8,fontSize:11,color:"var(--positive)",padding:"6px 10px",background:"#00D4AA10",borderRadius:6}}>
                  {sim.zeroCrossDate
                    ? `Float lasts ${sim.daysToSpare}d past payday if nothing else comes in.`
                    : `Float comfortably covers you — no deposit needed before payday.`}
                </div>
              ) : (
                <div style={{marginTop:8,fontSize:11,color:"#FF6B6B",padding:"6px 10px",background:"#FF6B6B10",borderRadius:6}}>
                  Runs dry {Math.abs(sim.daysToSpare)}d before payday — move money in or raise the float.
                </div>
              )}
            </div>
          );
        })()}

        {/* Roadmap */}
        {currentStep && (
          <div className="dash-card">
            <div className="dash-card-label">Current Milestone</div>
            <div className="dash-card-value" style={{fontSize:20, color:"var(--positive)"}}>{currentStep.label}</div>
            {nextStep && <div className="dash-card-sub">Next: {nextStep.label}</div>}
            <div className="dash-card-sub">{doneSteps} of {roadmap.length} complete</div>
          </div>
        )}

        {/* Float status */}
        {accounts.filter(a => a.floatEnabled !== false && a.floatMultiplier).map(a => {
          const monthly = monthlyBillsByAcct[a.last4] || 0;
          const targetMult = a.floatMultiplier || 1.5;
          const target  = monthly * targetMult;
          const bal     = latestBalance(a.last4) ?? 0;
          const actualMult = target > 0 ? (bal / monthly) : null;
          const diff    = bal - target;
          const col     = diff >= 0 ? "#00D4AA" : bal >= target * 0.75 ? "#F5C842" : "#FF6B6B";
          return (
            <div className="dash-card" key={a.last4}>
              <div className="dash-card-label">Operating Float · {a.label}</div>
              <div className="dash-card-value" style={{color:col}}>{fmtShort(bal)}</div>
              <div className="dash-card-sub">
                Target {fmtShort(target)} ({targetMult}×)
                {actualMult !== null && ` · Actual ${actualMult.toFixed(1)}×`}
                {" · "}{diff>=0?"+":""}{fmtShort(diff)}
              </div>
            </div>
          );
        })}

        {/* Upcoming bills */}
        {upcoming.length > 0 && (
          <div className="dash-card">
            <div className="dash-card-label">Due Soon</div>
            <div className="upcoming-list">
              {upcoming.map(a => {
                const dc = dueColor(a.days, dueThresholds);
                return (
                  <div className="upcoming-item" key={a.last4}>
                    <div>
                      <div className="upcoming-name">{a.label}</div>
                      <div className="upcoming-due" style={{color: dc}}>
                        {nextDueDateStr(a.dueDay)} · {a.days}d
                      </div>
                    </div>
                    <div className="upcoming-amt">
                      {a.bal !== null ? fmt(a.bal) : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── BillsScreen ──────────────────────────────────────────────────────────────

// ─── Trough Simulation Engine ─────────────────────────────────────────────────
//
// Runs a day-by-day simulation over the float window (floatMult × pay cycle).
// Each day: subtract bills due that day, add paycheck if it lands that day.
// Returns the full daily balance array, trough day, trough value,
// the actual date the account would hit $0 with no further deposits,
// the actual next payday date, and whether the float alone (no future
// deposits) lasts until that payday.

const PAY_DAYS_PER_YEAR = { weekly:52, biweekly:26, semimonthly:24, monthly:12 };
const PAY_CYCLE_DAYS    = { weekly:7,  biweekly:14, semimonthly:15, monthly:30 };

// Date helpers for paycheck tracking
function startOfToday() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d;
}

function daysUntilDate(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T00:00:00");
  if (isNaN(target.getTime())) return null;
  const today = startOfToday();
  return Math.round((target - today) / (1000*60*60*24));
}

function fmtDateShort(date) {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
}

// Rolls a stored "next payday" forward (by whole pay cycles) until it's
// today or later, so a date entered once stays accurate without upkeep.
function resolveNextPayDate(nextPayDate, cycleLen) {
  if (!nextPayDate) return null;
  let d = new Date(nextPayDate + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = startOfToday();
  if (d < today) {
    const daysBehind = Math.ceil((today - d) / (1000*60*60*24));
    const cyclesBehind = Math.ceil(daysBehind / cycleLen);
    d.setDate(d.getDate() + cyclesBehind * cycleLen);
  }
  return d;
}

function runTroughSimulation({ bills, totalBillsBal, netPay, frequency, floatMult, accounts, nextPayDate }) {
  const freq       = frequency || "biweekly";
  const cycleLen   = PAY_CYCLE_DAYS[freq] || 14;
  const perYear    = PAY_DAYS_PER_YEAR[freq] || 26;
  const paycheckAmt = parseFloat(netPay) || 0;
  const mult       = parseFloat(floatMult) || 1.5;

  // Resolve the actual next payday date (falls back to "one cycle from today"
  // if the user hasn't set a specific date yet)
  const resolvedPayDate = resolveNextPayDate(nextPayDate, cycleLen);
  const today = startOfToday();
  const firstPayOffset = resolvedPayDate
    ? Math.round((resolvedPayDate - today) / (1000*60*60*24))
    : cycleLen;

  // Simulation window = floatMult × one pay cycle, minimum 30 days, and always
  // long enough to include at least the next payday
  const windowDays = Math.max(30, Math.ceil(mult * cycleLen) + cycleLen, firstPayOffset + cycleLen);

  // Build bill events: day-of-month → total amount due
  const FREQ_MAP = { weekly:52, biweekly:26, semimonthly:24, monthly:12, quarterly:4, annual:1, onetime:0 };
  const billEvents = {}; // { [dayOfMonth]: amount }

  bills.forEach(b => {
    const day = b.dueDay;
    if (!day) return;
    const myPct = (parseFloat(b.myPct) || 100) / 100;
    const monthly = (parseFloat(b.amount)||0) * ((FREQ_MAP[b.frequency]||12)/12) * myPct;
    if (monthly <= 0) return;
    billEvents[day] = (billEvents[day] || 0) + monthly;
  });

  // Simulate day by day — one pass including future paychecks (for the trough
  // and cycle timeline), and a parallel "no deposit" balance (for the runway /
  // zero-crossing question: how long does the current balance alone last).
  let bal = totalBillsBal;
  let noDepositBal = totalBillsBal;
  const days = [];
  let lowestBal  = bal;
  let lowestDay  = 0;
  let lowestDate = new Date(today);
  let zeroCrossDay  = null;
  let zeroCrossDate = null;

  for (let d = 0; d < windowDays; d++) {
    const simDate = new Date(today);
    simDate.setDate(today.getDate() + d);
    const dom = simDate.getDate(); // day of month for this simulated day

    // Paycheck lands on the resolved payday, then every cycleLen days after
    let paycheckToday = 0;
    if (paycheckAmt > 0 && d === firstPayOffset) {
      paycheckToday = paycheckAmt;
    } else if (paycheckAmt > 0 && d > firstPayOffset && (d - firstPayOffset) % cycleLen === 0) {
      paycheckToday = paycheckAmt;
    }
    if (paycheckToday) bal += paycheckToday;

    // Subtract bills due today (by day of month) — both balances
    const billsDue = billEvents[dom] || 0;
    if (billsDue > 0) {
      bal -= billsDue;
      noDepositBal -= billsDue;
    }

    const dayEntry = {
      d,
      date: simDate,
      dateStr: simDate.toLocaleDateString("en-US", { month:"short", day:"numeric" }),
      bal: Math.round(bal * 100) / 100,
      noDepositBal: Math.round(noDepositBal * 100) / 100,
      billsDue,
      paycheckToday,
      dom,
    };
    days.push(dayEntry);

    if (bal < lowestBal) {
      lowestBal  = bal;
      lowestDay  = d;
      lowestDate = simDate;
    }
    if (zeroCrossDay === null && noDepositBal <= 0) {
      zeroCrossDay  = d;
      zeroCrossDate = new Date(simDate);
    }
  }

  // Monthly bill total (for zone lines)
  const monthlyTotal = Object.values(billEvents).reduce((s,v)=>s+v,0);

  // Float target = (monthly bills / paychecks per month) × paychecks in float window
  // Simplified: monthly × mult (same dollar amount, different meaning)
  const paychecksPerMonth = perYear / 12;
  const billsPerPaycheck  = monthlyTotal / paychecksPerMonth;
  const floatTarget       = billsPerPaycheck * mult * paychecksPerMonth; // = monthlyTotal * mult

  // "Where are you right now in the cycle"
  const troughExposure  = totalBillsBal - lowestBal; // how deep the trough is
  const troughLowest    = lowestBal;
  const troughDate      = lowestDate.toLocaleDateString("en-US", { month:"short", day:"numeric" });
  const cycleBillsTotal = billsPerPaycheck * mult; // bills expected in the float window

  // Zone thresholds (in dollar terms)
  const safeThresh = floatTarget;           // above this = safe (full float covered)
  const warnThresh = monthlyTotal;          // above monthly but below float = watch
  const dangThresh = monthlyTotal * 0.5;   // below half monthly = danger

  // Current zone
  const zone = totalBillsBal >= safeThresh ? "safe"
             : totalBillsBal >= warnThresh ? "warning"
             : "danger";
  const zoneColor = zone === "safe" ? "#00D4AA" : zone === "warning" ? "#F5C842" : "#FF6B6B";
  const zoneLabel = zone === "safe" ? "Covered" : zone === "warning" ? "Watch it" : "At risk";

  // ── The real question: does the float alone last until the next paycheck? ──
  // zeroCrossDay is null if the "no deposit" balance never hits $0 within the
  // simulated window — meaning the float comfortably outlasts this payday.
  const isSafeUntilPaycheck = zeroCrossDay === null || zeroCrossDay >= firstPayOffset;
  const daysToSpare = zeroCrossDay === null ? null : zeroCrossDay - firstPayOffset;

  return {
    days, monthlyTotal, floatTarget, safeThresh, warnThresh, dangThresh,
    troughLowest, troughExposure, troughDate, lowestDay,
    zone, zoneColor, zoneLabel,
    billsPerPaycheck, paycheckAmt, freq, cycleLen, mult, windowDays,
    // New: date-anchored runway info
    nextPaycheckDate: resolvedPayDate,
    nextPaycheckDateStr: fmtDateShort(resolvedPayDate),
    daysUntilPaycheck: firstPayOffset,
    zeroCrossDate,
    zeroCrossDateStr: fmtDateShort(zeroCrossDate),
    daysUntilZero: zeroCrossDay,
    isSafeUntilPaycheck,
    daysToSpare,
  };
}

// ─── BillsScaleView ──────────────────────────────────────────────────────────

function BillsScaleView({ accounts, bills, latestBalance, dueThresholds, paycheck, billsOverride, onSaveBillsOverride }) {
  const { billsBanks, totalBillsBal, monthlyTotal } = computeBillsHealth(accounts, bills, latestBalance);

  // Local override for pay settings (pulls from planner as default)
  const [localNetPay, setLocalNetPay]   = useState(billsOverride?.netPay   ?? paycheck?.netPay   ?? "");
  const [localFreq,   setLocalFreq]     = useState(billsOverride?.frequency ?? paycheck?.frequency ?? "biweekly");
  const [localNextPayDate, setLocalNextPayDate] = useState(billsOverride?.nextPayDate ?? paycheck?.nextPayDate ?? "");

  // Float multiplier from bills_bank accounts (use first one found, default 1.5)
  const floatMult = billsBanks[0]?.floatMultiplier ?? 1.5;

  const sim = billsBanks.length > 0 ? runTroughSimulation({
    bills, totalBillsBal,
    netPay: localNetPay,
    frequency: localFreq,
    floatMult,
    accounts,
    nextPayDate: localNextPayDate,
  }) : null;

  const PAY_FREQS = [
    { v:"weekly",      l:"Weekly" },
    { v:"biweekly",    l:"Biweekly (every 2 wks)" },
    { v:"semimonthly", l:"Semi-monthly (twice/mo)" },
    { v:"monthly",     l:"Monthly" },
  ];

  if (billsBanks.length === 0) return (
    <div className="history-empty">No bills account set up.<br/>Add an account with the Bills role in Accounts.</div>
  );

  const maxScale = sim ? Math.max(sim.safeThresh * 1.3, totalBillsBal * 1.1, 1) : 1;
  const currentPct  = sim ? Math.min(100, (totalBillsBal / maxScale) * 100) : 0;
  const safePct     = sim ? Math.min(100, (sim.safeThresh / maxScale) * 100) : 75;
  const warnPct     = sim ? Math.min(100, (sim.warnThresh / maxScale) * 100) : 50;
  const troughPct   = sim ? Math.min(100, Math.max(0, (sim.troughLowest / maxScale) * 100)) : 0;

  // Group days into paycheck cycles for the timeline
  const cycles = [];
  if (sim) {
    let cycle = { start:0, end:sim.cycleLen-1, days:[], paycheckDay:0 };
    sim.days.forEach((day, i) => {
      cycle.days.push(day);
      if ((i+1) % sim.cycleLen === 0 || i === sim.days.length-1) {
        cycles.push({...cycle});
        cycle = { start:i+1, end:i+sim.cycleLen, days:[], paycheckDay:i+1 };
      }
    });
  }

  return (
    <div style={{padding:"0 16px 20px"}}>

      {/* ── Pay settings override ── */}
      <div style={{background:"var(--card2)",border:"1px solid var(--border2)",borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:12}}>
          Paycheck Settings
        </div>
        <div style={{display:"flex",gap:10,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Net Pay</div>
            <input className="text-input" style={{padding:"8px 12px",fontSize:14}}
              placeholder="e.g. 3200" type="number" inputMode="decimal"
              value={localNetPay}
              onChange={e=>setLocalNetPay(e.target.value)}
              onBlur={()=>onSaveBillsOverride({netPay:localNetPay,frequency:localFreq,nextPayDate:localNextPayDate})}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Frequency</div>
            <select className="form-select" style={{padding:"8px 12px",fontSize:13}}
              value={localFreq}
              onChange={e=>{setLocalFreq(e.target.value);onSaveBillsOverride({netPay:localNetPay,frequency:e.target.value,nextPayDate:localNextPayDate});}}>
              {PAY_FREQS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Next Payday</div>
          <input className="text-input" style={{padding:"8px 12px",fontSize:14}}
            type="date"
            value={localNextPayDate}
            onChange={e=>setLocalNextPayDate(e.target.value)}
            onBlur={()=>onSaveBillsOverride({netPay:localNetPay,frequency:localFreq,nextPayDate:localNextPayDate})}/>
        </div>
        <div style={{fontSize:11,color:"var(--muted2)"}}>
          Float × {floatMult} set in Accounts · Pulls from Planner by default. Set the date once — it auto-advances each cycle.
        </div>
      </div>

      {sim && <>

        {/* ── Runway verdict: does the float last until payday? ── */}
        <div style={{
          background: sim.isSafeUntilPaycheck ? "#00D4AA12" : "#FF6B6B12",
          border:`1px solid ${sim.isSafeUntilPaycheck ? "#00D4AA40" : "#FF6B6B40"}`,
          borderRadius:14, padding:16, marginBottom:16
        }}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:18}}>{sim.isSafeUntilPaycheck ? "✅" : "⚠️"}</span>
            <div style={{fontSize:14,fontWeight:700,color:sim.isSafeUntilPaycheck?"#00D4AA":"#FF6B6B"}}>
              {sim.isSafeUntilPaycheck ? "Safe until your next paycheck" : "At risk before your next paycheck"}
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",gap:12,marginBottom:8}}>
            <div style={{flex:1}}>
              <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:3}}>Next Paycheck</div>
              <div style={{fontSize:15,fontWeight:600,color:"var(--text)"}}>
                {sim.nextPaycheckDateStr || "Set a date above"}
              </div>
              {sim.daysUntilPaycheck !== null && <div style={{fontSize:11,color:"var(--muted)",marginTop:1}}>in {sim.daysUntilPaycheck}d</div>}
            </div>
            <div style={{flex:1,textAlign:"right"}}>
              <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:3}}>Hits $0 (no deposits)</div>
              <div style={{fontSize:15,fontWeight:600,color:sim.zeroCrossDate?"#FF6B6B":"var(--positive)"}}>
                {sim.zeroCrossDateStr || "Never in window"}
              </div>
              {sim.daysUntilZero !== null && <div style={{fontSize:11,color:"var(--muted)",marginTop:1}}>in {sim.daysUntilZero}d</div>}
            </div>
          </div>
          {sim.isSafeUntilPaycheck ? (
            <div style={{padding:"8px 12px",background:"#00D4AA12",borderRadius:8,fontSize:12,color:"var(--positive)"}}>
              {sim.zeroCrossDate
                ? `If no more money came in, this account would run dry ${sim.daysToSpare}d after your paycheck lands — you're covered.`
                : `At the current pace, this account won't hit $0 before your next paycheck arrives.`}
            </div>
          ) : (
            <div style={{padding:"8px 12px",background:"#FF6B6B18",borderRadius:8,fontSize:12,color:"#FF6B6B"}}>
              If no more money comes in, this account runs out on {sim.zeroCrossDateStr} — {Math.abs(sim.daysToSpare)}d before your {sim.nextPaycheckDateStr} paycheck. Move money in or raise the float.
            </div>
          )}
        </div>

        {/* ── Trough warning card ── */}
        <div style={{
          background: sim.troughLowest < 0 ? "#FF6B6B12" : "var(--card)",
          border:`1px solid ${sim.troughLowest < 0 ? "#FF6B6B40" : "var(--border)"}`,
          borderRadius:14, padding:16, marginBottom:16
        }}>
          <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:10}}>
            Trough Forecast
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontSize:13,color:"var(--text2)",marginBottom:4}}>
                Lowest expected balance
              </div>
              <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:28,fontWeight:700,
                color:sim.troughLowest>=sim.warnThresh?"#00D4AA":sim.troughLowest>=0?"#F5C842":"#FF6B6B",
                lineHeight:1}}>
                {fmt(sim.troughLowest)}
              </div>
              <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>
                Around {sim.troughDate} · day {sim.lowestDay} of simulation
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Trough depth</div>
              <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:18,fontWeight:600,
                color: sim.troughExposure > totalBillsBal*0.5 ? "#FF6B6B" : "#F5C842"}}>
                −{fmt(sim.troughExposure)}
              </div>
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>from current</div>
            </div>
          </div>
          {sim.troughLowest < 0 && (
            <div style={{marginTop:12,padding:"8px 12px",background:"#FF6B6B18",borderRadius:8,fontSize:12,color:"#FF6B6B"}}>
              ⚠ With a {sim.mult}× float this account would go negative. Consider raising the float or moving more money in.
            </div>
          )}
          {sim.troughLowest >= 0 && sim.troughLowest < sim.warnThresh && (
            <div style={{marginTop:12,padding:"8px 12px",background:"#F5C84218",borderRadius:8,fontSize:12,color:"#F5C842"}}>
              This account gets tight but stays positive. You're betting on no surprises.
            </div>
          )}
          {sim.troughLowest >= sim.warnThresh && (
            <div style={{marginTop:12,padding:"8px 12px",background:"#00D4AA12",borderRadius:8,fontSize:12,color:"var(--positive)"}}>
              Your float fully covers the {sim.mult}× window. You have room for variable bills.
            </div>
          )}
        </div>

        {/* ── Scale bar ── */}
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:600,letterSpacing:"1.5px",textTransform:"uppercase",color:"var(--muted2)"}}>
              Bills Account · Now
            </span>
            <span style={{fontFamily:"'Space Grotesk',monospace",fontSize:22,fontWeight:700,color:sim.zoneColor}}>
              {fmt(totalBillsBal)}
            </span>
          </div>

          <div style={{position:"relative",height:32,borderRadius:16,overflow:"hidden",background:"var(--bg2)",marginBottom:6}}>
            {/* zone fills */}
            <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${warnPct}%`,background:"#FF6B6B18"}}/>
            <div style={{position:"absolute",left:`${warnPct}%`,top:0,bottom:0,width:`${safePct-warnPct}%`,background:"#F5C84212"}}/>
            <div style={{position:"absolute",left:`${safePct}%`,top:0,bottom:0,right:0,background:"#00D4AA0A"}}/>
            {/* zone lines */}
            <div style={{position:"absolute",left:`${warnPct}%`,top:0,bottom:0,width:2,background:"#F5C842",opacity:0.4}}/>
            <div style={{position:"absolute",left:`${safePct}%`,top:0,bottom:0,width:2,background:"var(--positive)",opacity:0.4}}/>
            {/* trough marker */}
            <div style={{position:"absolute",left:`${troughPct}%`,top:2,bottom:2,width:2,background:"#FF6B6B",opacity:0.7,borderRadius:1}}/>
            <div style={{position:"absolute",left:`${Math.max(0,troughPct-8)}%`,top:10,fontSize:8,color:"#FF6B6B",opacity:0.8,whiteSpace:"nowrap"}}>▼trough</div>
            {/* current fill */}
            <div style={{position:"absolute",left:0,top:5,bottom:5,width:`${currentPct}%`,background:sim.zoneColor,borderRadius:10,transition:"width .5s ease"}}/>
          </div>

          {/* Scale labels */}
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
            <span style={{fontSize:10,color:"#FF6B6B"}}>At risk</span>
            <span style={{fontSize:10,color:"#F5C842"}}>Watch it</span>
            <span style={{fontSize:10,color:"var(--positive)"}}>Covered ({sim.mult}×)</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:10,color:"var(--muted)"}}>0</span>
            <span style={{fontSize:10,color:"var(--muted)"}}>{fmt(sim.warnThresh)}</span>
            <span style={{fontSize:10,color:"var(--muted)"}}>{fmt(sim.safeThresh)}</span>
          </div>
        </div>

        {/* ── Bills account balances ── */}
        {billsBanks.map(a=>(
          <div key={a.last4} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:"var(--text2)"}}>{a.label}</div>
              <div style={{fontSize:11,color:"var(--muted)"}}>•••• {a.last4} · Float ×{a.floatMultiplier||1.5}</div>
            </div>
            <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:"var(--accent)"}}>
              {latestBalance(a.last4)!==null ? fmt(latestBalance(a.last4)) : "—"}
            </div>
          </div>
        ))}

        {/* ── Cycle timeline ── */}
        <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"var(--muted2)",margin:"20px 0 10px"}}>
          {sim.mult}× Float Simulation · {sim.days.length} days
        </div>

        {cycles.slice(0, Math.ceil(sim.mult)+1).map((cycle, ci) => {
          const billDays = cycle.days.filter(d => d.billsDue > 0);
          const paycheckDay = cycle.days.find(d => d.paycheckToday > 0);
          const startBal = ci === 0 ? totalBillsBal : cycles[ci-1].days[cycles[ci-1].days.length-1].bal;
          const endBal   = cycle.days[cycle.days.length-1].bal;
          const cycleTrough = Math.min(...cycle.days.map(d=>d.bal));
          const cycleCol = endBal >= sim.warnThresh ? "#00D4AA" : endBal >= 0 ? "#F5C842" : "#FF6B6B";
          return (
            <div key={ci} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:14,padding:"14px 16px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>
                    {ci===0 ? "Now" : `Cycle ${ci+1}`} · {cycle.days[0].dateStr}–{cycle.days[cycle.days.length-1].dateStr}
                  </div>
                  {paycheckDay && (
                    <div style={{fontSize:11,color:"var(--positive)",marginTop:2}}>
                      +{fmt(sim.paycheckAmt)} paycheck on {paycheckDay.dateStr}
                    </div>
                  )}
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:"var(--muted)"}}>Ends at</div>
                  <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:cycleCol}}>{fmt(endBal)}</div>
                  <div style={{fontSize:10,color:"var(--muted2)",marginTop:1}}>low: {fmt(cycleTrough)}</div>
                </div>
              </div>
              {billDays.length > 0 && (
                <div style={{borderTop:"1px solid var(--border)",paddingTop:8}}>
                  {billDays.map((d,j)=>(
                    <div key={j} style={{display:"flex",justifyContent:"space-between",padding:"3px 0"}}>
                      <span style={{fontSize:12,color:"var(--muted)"}}>{d.dateStr}</span>
                      <span style={{fontSize:12,color:"#F5A623"}}>−{fmt(d.billsDue)}</span>
                      <span style={{fontFamily:"'Space Grotesk',monospace",fontSize:12,
                        color:d.bal>=sim.warnThresh?"var(--text2)":d.bal>=0?"#F5C842":"#FF6B6B"}}>{fmt(d.bal)}</span>
                    </div>
                  ))}
                </div>
              )}
              {billDays.length === 0 && (
                <div style={{fontSize:12,color:"var(--muted2)",borderTop:"1px solid var(--border)",paddingTop:8}}>No bills due this cycle</div>
              )}
            </div>
          );
        })}

        {billDueDays(bills) === 0 && (
          <div style={{fontSize:13,color:"var(--muted2)",textAlign:"center",padding:"16px 0"}}>
            Set due days on your bills to see the cycle timeline.
          </div>
        )}
      </>}
    </div>
  );
}

function billDueDays(bills) {
  return bills.filter(b=>b.dueDay).length;
}
const FREQ_LABELS = { weekly:"Weekly", biweekly:"Biweekly", semimonthly:"Semi-monthly",
                      monthly:"Monthly", quarterly:"Quarterly", annual:"Annual", onetime:"One-time" };
const FREQ_PER_YEAR_MAP = { weekly:52, biweekly:26, semimonthly:24, monthly:12, quarterly:4, annual:1, onetime:0 };

function monthlyEquiv(bill) {
  const annual = (parseFloat(bill.amount) || 0) * (FREQ_PER_YEAR_MAP[bill.frequency] || 12);
  return annual / 12;
}

const EMPTY_BILL = {
  name:"", amount:"", frequency:"monthly", myPct:"100", theirPct:"0",
  fundingAcct:"", paymentAcct:"", creditCard:"", rewardMult:"",
  isEF:false, isRetire:false, isFixed:true, isAutopay:false, notes:"", dueDay:null
};

function BillForm({ bill, accounts, onSave, onCancel }) {
  const [b, setB] = useState(bill);
  function set(k, v) { setB(prev => ({...prev, [k]: v})); }
  const Toggle = ({k}) => (
    <button className={`toggle ${b[k] ? "on" : "off"}`} onClick={() => set(k, !b[k])}>
      <div className="toggle-knob"/>
    </button>
  );
  const allAccts = accounts;
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal-title">{bill.id ? "Edit Bill" : "Add Bill"}</div>

        <div className="form-group">
          <label className="form-label">Bill Name</label>
          <input className="form-input" placeholder="e.g. Netflix" value={b.name} onChange={e=>set("name",e.target.value)}/>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Amount</label>
            <input className="form-input" placeholder="0.00" type="number" inputMode="decimal" value={b.amount} onChange={e=>set("amount",e.target.value)}/>
          </div>
          <div className="form-group">
            <label className="form-label">Frequency</label>
            <select className="form-select" value={b.frequency} onChange={e=>set("frequency",e.target.value)}>
              {Object.entries(FREQ_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">My %</label>
            <input className="form-input" placeholder="100" type="number" inputMode="numeric" value={b.myPct} onChange={e=>set("myPct",e.target.value)}/>
          </div>
          <div className="form-group">
            <label className="form-label">Their %</label>
            <input className="form-input" placeholder="0" type="number" inputMode="numeric" value={b.theirPct} onChange={e=>set("theirPct",e.target.value)}/>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Funding Account (deposit lands here)</label>
          <select className="form-select" value={b.fundingAcct} onChange={e=>set("fundingAcct",e.target.value)}>
            <option value="">None</option>
            {allAccts.map(a=><option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Payment Account (pays the bill)</label>
          <select className="form-select" value={b.paymentAcct} onChange={e=>set("paymentAcct",e.target.value)}>
            <option value="">None</option>
            {allAccts.map(a=><option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Credit Card Used (optional)</label>
          <select className="form-select" value={b.creditCard} onChange={e=>set("creditCard",e.target.value)}>
            <option value="">None</option>
            {accounts.filter(a=>a.role==="credit_card").map(a=><option key={a.last4} value={a.last4}>{a.label} (•{a.last4})</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Reward Multiplier</label>
          <input className="form-input" placeholder="e.g. 3x travel" value={b.rewardMult} onChange={e=>set("rewardMult",e.target.value)}/>
        </div>
        <div className="form-group">
          <label className="form-label">Notes</label>
          <input className="form-input" placeholder="Optional notes" value={b.notes} onChange={e=>set("notes",e.target.value)}/>
        </div>
        <div className="form-group">
          <label className="form-label">Due Day of Month</label>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <input className="form-input" style={{maxWidth:100}} placeholder="e.g. 15"
              type="number" inputMode="numeric" min="1" max="31"
              value={b.dueDay??""} onChange={e=>set("dueDay", e.target.value ? parseInt(e.target.value) : null)}/>
            <span style={{fontSize:13,color:"var(--muted)"}}>of each month</span>
          </div>
        </div>
        <div className="form-toggle-row"><span className="form-toggle-label">Fixed (not variable)</span><Toggle k="isFixed"/></div>
        <div className="form-toggle-row"><span className="form-toggle-label">Autopay</span><Toggle k="isAutopay"/></div>
        <div className="form-toggle-row"><span className="form-toggle-label">Emergency Fund Expense</span><Toggle k="isEF"/></div>
        <div className="form-toggle-row"><span className="form-toggle-label">Retirement Expense</span><Toggle k="isRetire"/></div>

        <button className="form-save-btn" onClick={()=>onSave(b)}>Save Bill</button>
        <button className="form-cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function BillsScreen({ bills, accounts, onAddBill, onEditBill, onDeleteBill, latestBalance, dueThresholds, paycheck, onSavePaycheck }) {
  const [showForm, setShowForm] = useState(false);
  const [editingBill, setEditingBill] = useState(null);

  function handleSave(b) {
    if (b.id) onEditBill(b); else onAddBill(b);
    setShowForm(false); setEditingBill(null);
  }

  const totalMonthly = bills.reduce((s,b) => s + monthlyEquiv(b) * ((parseFloat(b.myPct)||100)/100), 0);

  const [viewMode, setViewMode] = useState("scale");

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Bills</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif", fontSize:16, fontWeight:700, color:"var(--text)"}}>
          {fmt(totalMonthly)}<span style={{fontSize:11,color:"var(--muted)",fontWeight:400}}>/mo</span>
        </div>
      </div>

      <div className="view-toggle">
        <button className={`view-btn ${viewMode==="scale"?"active":""}`} onClick={()=>setViewMode("scale")}>◉ Scale</button>
        <button className={`view-btn ${viewMode==="planner"?"active":""}`} onClick={()=>setViewMode("planner")}>⊟ Planner</button>
        <button className={`view-btn ${viewMode==="tile"?"active":""}`} onClick={()=>setViewMode("tile")}>⊞ Tiles</button>
        <button className={`view-btn ${viewMode==="list"?"active":""}`} onClick={()=>setViewMode("list")}>≡ List</button>
      </div>

      {bills.length === 0 && (
        <div className="history-empty">No bills yet.<br/>Tap + to add your first bill.</div>
      )}

      {viewMode === "scale" && (
        <BillsScaleView accounts={accounts} bills={bills} latestBalance={latestBalance} dueThresholds={dueThresholds}/>
      )}
      {viewMode === "planner" && (
        <PlannerScreen bills={bills} paycheck={paycheck} onSavePaycheck={onSavePaycheck} embedded={true}/>
      )}
      {viewMode === "tile" && (
        <div className="bill-list">
          {bills.map(bill => {
            const monthly = monthlyEquiv(bill) * ((parseFloat(bill.myPct)||100)/100);
            return (
              <div className="bill-card" key={bill.id}>
                <div className="bill-card-top">
                  <div>
                    <div className="bill-name">{bill.name}</div>
                    <div className="bill-meta">
                      {FREQ_LABELS[bill.frequency]} · {bill.myPct}% my share
                      {bill.fundingAcct && ` · Fund: •${bill.fundingAcct}`}
                      {bill.paymentAcct && ` → Pay: •${bill.paymentAcct}`}
                    </div>
                  </div>
                  <div>
                    <div className="bill-amount">{fmt(parseFloat(bill.amount)||0)}</div>
                    <div className="bill-amount-sub">{fmt(monthly)}/mo</div>
                  </div>
                </div>
                <div className="bill-tags">
                  {bill.isAutopay && <span className="bill-tag tag-auto">Autopay</span>}
                  {bill.isFixed   && <span className="bill-tag tag-fixed">Fixed</span>}
                  {!bill.isFixed  && <span className="bill-tag tag-var">Variable</span>}
                  {bill.isEF      && <span className="bill-tag tag-ef">Emergency Fund</span>}
                  {bill.isRetire  && <span className="bill-tag tag-retire">Retirement</span>}
                  {bill.rewardMult && <span className="bill-tag" style={{background:"#F5C84218",color:"#F5C842"}}>{bill.rewardMult}</span>}
                </div>
                <div className="bill-actions">
                  <button className="bill-action-btn btn-edit" onClick={()=>{setEditingBill(bill);setShowForm(true);}}>Edit</button>
                  <button className="bill-action-btn btn-delete" onClick={()=>onDeleteBill(bill.id)}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewMode === "list" && (
        <div className="bills-table-wrap">
          <table className="bills-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Amount</th>
                <th>Freq</th>
                <th>My %</th>
                <th>/mo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bills.map(bill => {
                const monthly = monthlyEquiv(bill) * ((parseFloat(bill.myPct)||100)/100);
                return (
                  <tr key={bill.id}>
                    <td>
                      <input className="tbl-input" defaultValue={bill.name}
                        onBlur={e=>onEditBill({...bill,name:e.target.value})}/>
                    </td>
                    <td>
                      <input className="tbl-input" style={{width:70}} defaultValue={bill.amount} type="number"
                        onBlur={e=>onEditBill({...bill,amount:e.target.value})}/>
                    </td>
                    <td>
                      <select style={{background:"transparent",border:"none",color:"var(--text2)",fontSize:12,fontFamily:"'DM Sans',sans-serif",cursor:"pointer"}}
                        value={bill.frequency} onChange={e=>onEditBill({...bill,frequency:e.target.value})}>
                        {Object.entries(FREQ_LABELS).map(([k,v])=><option key={k} value={k}>{v.split(" ")[0]}</option>)}
                      </select>
                    </td>
                    <td>
                      <input className="tbl-input" style={{width:44}} defaultValue={bill.myPct} type="number"
                        onBlur={e=>onEditBill({...bill,myPct:e.target.value})}/>
                    </td>
                    <td style={{color:"var(--muted)",fontFamily:"'Space Grotesk',monospace",fontSize:13}}>{fmt(monthly)}</td>
                    <td>
                      <button style={{background:"none",border:"none",color:"#FF6B6B",cursor:"pointer",fontSize:14}}
                        onClick={()=>onDeleteBill(bill.id)}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <button className="fab" onClick={()=>{setEditingBill(null);setShowForm(true);}}>+</button>

      {showForm && (
        <BillForm
          bill={editingBill || EMPTY_BILL}
          accounts={accounts}
          onSave={handleSave}
          onCancel={()=>{setShowForm(false);setEditingBill(null);}}
        />
      )}
    </div>
  );
}

// ─── PlannerScreen ────────────────────────────────────────────────────────────

const FREQ_OPTIONS = [
  {v:"weekly",       l:"Weekly"},
  {v:"biweekly",     l:"Biweekly (every 2 weeks)"},
  {v:"semimonthly",  l:"Semi-monthly (twice/month)"},
  {v:"monthly",      l:"Monthly"},
];

function PlannerScreen({ bills, paycheck, onSavePaycheck, embedded=false }) {
  const [netPay, setNetPay]     = useState(paycheck.netPay || "");
  const [freq,   setFreq]       = useState(paycheck.frequency || "biweekly");
  const [nextPayDate, setNextPayDate] = useState(paycheck.nextPayDate || "");

  const FREQ_PER_YEAR = { weekly:52, biweekly:26, semimonthly:24, monthly:12 };
  const perYear = FREQ_PER_YEAR[freq] || 26;
  const net = parseFloat(netPay) || 0;

  function reservePerPaycheck(bill) {
    const myPct  = parseFloat(bill.myPct) || 100;
    const annual = (parseFloat(bill.amount) || 0) * (FREQ_PER_YEAR_MAP[bill.frequency] || 12) * (myPct / 100);
    return annual / perYear;
  }

  const lineItems = bills.map(b => ({ ...b, reserve: reservePerPaycheck(b) }))
                         .filter(b => b.reserve > 0)
                         .sort((a,b) => b.reserve - a.reserve);
  const totalReserve = lineItems.reduce((s,b) => s + b.reserve, 0);
  const remaining    = net - totalReserve;

  const resolvedNextPay = resolveNextPayDate(nextPayDate, PAY_CYCLE_DAYS[freq] || 14);
  const daysToNextPay   = resolvedNextPay ? daysUntilDate(resolvedNextPay.toISOString().slice(0,10)) : null;

  function handleSave() { onSavePaycheck({ netPay, frequency: freq, nextPayDate }); }

  return (
    <div className={embedded?"":"screen"}>
      {!embedded && <div className="screen-title">Paycheck Planner</div>}

      <div style={{padding:"0 16px", marginBottom:16}}>
        <div className="form-group">
          <label className="form-label">Net Pay (take-home)</label>
          <input className="form-input" placeholder="0.00" type="number" inputMode="decimal"
            value={netPay} onChange={e=>setNetPay(e.target.value)} onBlur={handleSave}/>
        </div>
        <div className="form-group">
          <label className="form-label">Pay Frequency</label>
          <select className="form-select" value={freq} onChange={e=>{setFreq(e.target.value); setTimeout(handleSave,50);}}>
            {FREQ_OPTIONS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Next Payday</label>
          <input className="form-input" type="date"
            value={nextPayDate} onChange={e=>setNextPayDate(e.target.value)} onBlur={handleSave}/>
          {resolvedNextPay && (
            <div style={{fontSize:11,color:"var(--muted)",marginTop:6}}>
              Next paycheck: <strong style={{color:"var(--text2)"}}>{fmtDateShort(resolvedNextPay)}</strong>
              {daysToNextPay !== null && ` · in ${daysToNextPay}d`} · set once, auto-advances each cycle
            </div>
          )}
        </div>
      </div>

      {net > 0 && (
        <>
          <div className="planner-hero">
            {resolvedNextPay && (
              <div className="planner-row">
                <span className="planner-lbl">Next Paycheck</span>
                <span className="planner-val" style={{fontSize:19}}>{fmtDateShort(resolvedNextPay)}{daysToNextPay!==null && ` · ${daysToNextPay}d`}</span>
              </div>
            )}
            <div className="planner-row">
              <span className="planner-lbl">Paycheck</span>
              <span className="planner-val">{fmt(net)}</span>
            </div>
            <div className="planner-row">
              <span className="planner-lbl">Reserved for bills</span>
              <span className="planner-val" style={{color:"#F5A623"}}>−{fmt(totalReserve)}</span>
            </div>
            <div className="planner-row">
              <span className="planner-lbl">Projected Safe to Spend</span>
              <span className="planner-val" style={{color: remaining>=0?"#00D4AA":"#FF6B6B"}}>{fmt(remaining)}</span>
            </div>
          </div>

          <div className="section-label" style={{marginTop:8}}>Reserve Breakdown</div>
          <div className="planner-section">
            {lineItems.map(b => (
              <div className="planner-bill-row" key={b.id}>
                <div>
                  <div className="planner-bill-name">{b.name}</div>
                  <div className="planner-bill-sub">{FREQ_LABELS[b.frequency]} · {b.myPct}% my share</div>
                </div>
                <div className="planner-bill-amt">{fmt(b.reserve)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {net === 0 && (
        <div className="history-empty">Enter your take-home pay above<br/>to see your reserve plan.</div>
      )}
    </div>
  );
}

// ─── RoadmapScreen ────────────────────────────────────────────────────────────

const DEFAULT_ROADMAP = [
  { id:1,  label:"Starter Emergency Fund",          status:"current", completedAt:undefined },
  { id:2,  label:"Planned Expense Reserve",         status:"future",  completedAt:undefined },
  { id:3,  label:"Separate Planned Expense Account",status:"future",  completedAt:undefined },
  { id:4,  label:"Pay Off Debt",                    status:"future",  completedAt:undefined },
  { id:5,  label:"High Yield Savings",              status:"future",  completedAt:undefined },
  { id:6,  label:"Three Month Emergency Fund",      status:"future",  completedAt:undefined },
  { id:7,  label:"Variable Expense Reserve",        status:"future",  completedAt:undefined },
  { id:8,  label:"Company Match",                   status:"future",  completedAt:undefined },
  { id:9,  label:"Max HSA",                         status:"future",  completedAt:undefined },
  { id:10, label:"Open Roth IRA",                   status:"future",  completedAt:undefined },
  { id:11, label:"Open Traditional IRA",            status:"future",  completedAt:undefined },
  { id:12, label:"Open Brokerage",                  status:"future",  completedAt:undefined },
  { id:13, label:"Max Roth IRA",                    status:"future",  completedAt:undefined },
  { id:14, label:"Investment Milestone",            status:"future",  completedAt:undefined },
  { id:15, label:"Max 401(k)",                      status:"future",  completedAt:undefined },
  { id:16, label:"Mega Backdoor Roth",              status:"future",  completedAt:undefined },
];

// ─── Compact Roadmap (kata current/target condition style) ────────────────────

function KataRoadmap({ roadmap, onUpdateRoadmap }) {
  const [showAdd,    setShowAdd]    = useState(false);
  const [newLabel,   setNewLabel]   = useState("");
  const [editId,     setEditId]     = useState(null);
  const [editVal,    setEditVal]    = useState("");
  const [editDateId, setEditDateId] = useState(null);
  const [editDateVal,setEditDateVal]= useState("");

  const doneSteps    = roadmap.filter(s=>s.status==="done");
  const currentStep  = roadmap.find(s=>s.status==="current");
  const futureSteps  = roadmap.filter(s=>s.status==="future");
  const nextStep     = futureSteps[0];
  const doneCount    = doneSteps.length;
  const total        = roadmap.length;

  function markDone(id) {
    const d = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
    onUpdateRoadmap(roadmap.map(s=>s.id===id?{...s,status:"done",completedAt:s.completedAt||d}:s));
  }
  function setStatus(id,status) {
    onUpdateRoadmap(roadmap.map(s=>s.id===id?{...s,status,completedAt:status==="done"?(s.completedAt||new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})):undefined}:s));
  }
  function moveStep(id,dir) {
    const steps=[...roadmap];
    const idx=steps.findIndex(s=>s.id===id);
    const swap=dir==="up"?idx-1:idx+1;
    if(swap<0||swap>=steps.length)return;
    [steps[idx],steps[swap]]=[steps[swap],steps[idx]];
    onUpdateRoadmap(steps);
  }
  function deleteStep(id){onUpdateRoadmap(roadmap.filter(s=>s.id!==id));}
  function addStep(){
    if(!newLabel.trim())return;
    onUpdateRoadmap([...roadmap,{id:Date.now(),label:newLabel.trim(),status:"future"}]);
    setNewLabel("");setShowAdd(false);
  }
  function saveEdit(id){onUpdateRoadmap(roadmap.map(s=>s.id===id?{...s,label:editVal}:s));setEditId(null);}
  function saveDate(id){onUpdateRoadmap(roadmap.map(s=>s.id===id?{...s,completedAt:editDateVal}:s));setEditDateId(null);}

  const pct = total > 0 ? Math.round((doneCount/total)*100) : 0;

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Roadmap</div>
        <div style={{fontSize:13,color:"var(--muted)"}}>{doneCount}/{total} done</div>
      </div>

      {/* ── Kata board: current condition → challenge → target condition ── */}
      <div style={{padding:"0 16px 16px"}}>

        {/* Progress bar */}
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:11,color:"var(--muted)",letterSpacing:"1px",textTransform:"uppercase"}}>Overall Progress</span>
            <span style={{fontSize:13,fontFamily:"'Space Grotesk',monospace",color:"var(--positive)",fontWeight:700}}>{pct}%</span>
          </div>
          <div className="progress-bar" style={{height:8}}>
            <div className="progress-fill" style={{width:`${pct}%`}}/>
          </div>
        </div>

        {/* Three-panel kata board */}
        <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:8,marginBottom:20}}>

          {/* Current Condition */}
          <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:14,padding:14}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:8}}>Current</div>
            {currentStep ? (
              <>
                <div style={{fontSize:14,fontWeight:600,color:"var(--text)",lineHeight:1.3,marginBottom:6}}>{currentStep.label}</div>
                <span className="step-badge badge-current" style={{fontSize:9}}>In progress</span>
              </>
            ) : (
              <div style={{fontSize:13,color:"var(--muted2)"}}>Not set</div>
            )}
          </div>

          {/* Arrow + challenge */}
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
            <div style={{fontSize:20,color:"var(--muted2)"}}>→</div>
            <div style={{fontSize:9,color:"var(--muted2)",textAlign:"center",letterSpacing:"1px",textTransform:"uppercase"}}>Next</div>
          </div>

          {/* Target Condition */}
          <div style={{background:"var(--card2)",border:"1px solid #00D4AA30",borderRadius:14,padding:14}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:"#00D4AA60",marginBottom:8}}>Target</div>
            {nextStep ? (
              <>
                <div style={{fontSize:14,fontWeight:600,color:"var(--text2)",lineHeight:1.3,marginBottom:6}}>{nextStep.label}</div>
                <span style={{fontSize:9,fontWeight:600,letterSpacing:"1px",background:"#00D4AA15",color:"#00D4AA60",padding:"2px 6px",borderRadius:8}}>Upcoming</span>
              </>
            ) : doneCount === total && total > 0 ? (
              <div style={{fontSize:13,color:"var(--positive)",fontWeight:600}}>All done! 🎉</div>
            ) : (
              <div style={{fontSize:13,color:"var(--muted2)"}}>Add milestones below</div>
            )}
          </div>
        </div>

        {/* Last completed */}
        {doneSteps.length > 0 && (
          <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"12px 14px",marginBottom:16,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:9,color:"var(--muted)",letterSpacing:"1px",textTransform:"uppercase",marginBottom:4}}>Last Completed</div>
              <div style={{fontSize:14,color:"var(--positive)",fontWeight:600}}>{doneSteps[doneSteps.length-1].label}</div>
            </div>
            <div style={{fontSize:18,color:"var(--positive)"}}>✓</div>
          </div>
        )}
      </div>

      {/* ── All milestones list ── */}
      <div className="section-label">All Milestones</div>
      <div style={{padding:"0 16px 100px"}}>
        {roadmap.map((step,idx)=>{
          const isLast = idx===roadmap.length-1;
          const col = step.status==="done"?"#00D4AA":step.status==="current"?"var(--text)":"var(--muted2)";
          return (
            <div key={step.id} style={{
              background:"var(--card)",
              border:`1px solid ${step.status==="current"?"#00D4AA40":"var(--border)"}`,
              borderRadius:12,padding:"12px 14px",marginBottom:6,
              opacity:step.status==="future"?0.65:1
            }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{flex:1}}>
                  {editId===step.id?(
                    <div style={{display:"flex",gap:8,marginBottom:4}}>
                      <input className="text-input" style={{flex:1,padding:"6px 10px",fontSize:14}}
                        value={editVal} onChange={e=>setEditVal(e.target.value)}/>
                      <button className="add-btn" style={{padding:"6px 12px",fontSize:13}} onClick={()=>saveEdit(step.id)}>Save</button>
                    </div>
                  ):(
                    <div style={{fontSize:14,fontWeight:600,color:col,marginBottom:3}}>{step.label}</div>
                  )}
                  {step.status==="done"&&(
                    <div style={{fontSize:11,color:"var(--muted)"}}>
                      {editDateId===step.id?(
                        <input className="tbl-input" style={{width:130,fontSize:11,display:"inline"}}
                          value={editDateVal} onChange={e=>setEditDateVal(e.target.value)}
                          onBlur={()=>saveDate(step.id)} onKeyDown={e=>e.key==="Enter"&&saveDate(step.id)} autoFocus/>
                      ):(
                        <span className="roadmap-edit-date"
                          onClick={()=>{setEditDateId(step.id);setEditDateVal(step.completedAt||"");}}>
                          ✓ {step.completedAt||"tap to set date"}
                        </span>
                      )}
                    </div>
                  )}
                  {step.status==="current"&&<span className="step-badge badge-current" style={{fontSize:9}}>Current</span>}
                </div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end"}}>
                  {step.status!=="done"&&<button className="roadmap-btn rmbtn-done" onClick={()=>markDone(step.id)}>✓</button>}
                  {step.status!=="current"&&<button className="roadmap-btn rmbtn-current" onClick={()=>setStatus(step.id,"current")}>Current</button>}
                  {idx>0&&<button className="roadmap-btn rmbtn-up" onClick={()=>moveStep(step.id,"up")}>↑</button>}
                  {!isLast&&<button className="roadmap-btn rmbtn-down" onClick={()=>moveStep(step.id,"down")}>↓</button>}
                  {editId!==step.id&&<button className="roadmap-btn" style={{background:"var(--border)",color:"var(--text2)"}}
                    onClick={()=>{setEditId(step.id);setEditVal(step.label);}}>✎</button>}
                  <button className="roadmap-btn rmbtn-del" onClick={()=>deleteStep(step.id)}>✕</button>
                </div>
              </div>
            </div>
          );
        })}

        {showAdd?(
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <input className="text-input" style={{flex:1}} placeholder="New milestone…"
              value={newLabel} onChange={e=>setNewLabel(e.target.value)}/>
            <button className="add-btn" onClick={addStep}>Add</button>
          </div>
        ):(
          <button className="form-save-btn" style={{marginTop:8}} onClick={()=>setShowAdd(true)}>+ Add Milestone</button>
        )}
      </div>
    </div>
  );
}


// ─── InvestScreen (inside SettingsScreen tab) ─────────────────────────────────

const EMPTY_INVEST = { name:"", current:"", goal:"", targetType:"date", targetDate:"", targetAge:"", notes:"" };

function InvestForm({ inv, onSave, onCancel }) {
  const [v, setV] = useState(inv);
  function set(k, val) { setV(prev=>({...prev,[k]:val})); }
  return (
    <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div className="modal">
        <div className="modal-title">{inv.id ? "Edit Goal" : "Add Investment Goal"}</div>
        <div className="form-group">
          <label className="form-label">Account Name</label>
          <input className="form-input" placeholder="e.g. Roth IRA" value={v.name} onChange={e=>set("name",e.target.value)}/>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Current Balance</label>
            <input className="form-input" placeholder="0.00" type="number" inputMode="decimal" value={v.current} onChange={e=>set("current",e.target.value)}/>
          </div>
          <div className="form-group">
            <label className="form-label">Goal Balance</label>
            <input className="form-input" placeholder="0.00" type="number" inputMode="decimal" value={v.goal} onChange={e=>set("goal",e.target.value)}/>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Target Type</label>
          <select className="form-select" value={v.targetType} onChange={e=>set("targetType",e.target.value)}>
            <option value="date">Target Date</option>
            <option value="age">Target Age</option>
          </select>
        </div>
        {v.targetType === "date" && (
          <div className="form-group">
            <label className="form-label">Target Date</label>
            <input className="form-input" placeholder="e.g. Dec 2035" value={v.targetDate} onChange={e=>set("targetDate",e.target.value)}/>
          </div>
        )}
        {v.targetType === "age" && (
          <div className="form-group">
            <label className="form-label">Target Age</label>
            <input className="form-input" placeholder="e.g. 65" type="number" inputMode="numeric" value={v.targetAge} onChange={e=>set("targetAge",e.target.value)}/>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Notes</label>
          <input className="form-input" placeholder="Optional" value={v.notes} onChange={e=>set("notes",e.target.value)}/>
        </div>
        <button className="form-save-btn" onClick={()=>onSave(v)}>Save Goal</button>
        <button className="form-cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function InvestScreen({ investments, onAddInvest, onEditInvest, onDeleteInvest }) {
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);

  function handleSave(v) {
    if (v.id) onEditInvest(v); else onAddInvest(v);
    setShowForm(false); setEditing(null);
  }

  return (
    <div className="screen">
      <div className="screen-title">Investment Goals</div>

      {investments.length === 0 && (
        <div className="history-empty">No investment goals yet.<br/>Tap + to add one.</div>
      )}

      <div className="invest-list">
        {investments.map(inv => {
          const cur  = parseFloat(inv.current) || 0;
          const goal = parseFloat(inv.goal) || 0;
          const pct  = goal > 0 ? Math.min(100, Math.round((cur/goal)*100)) : 0;
          const target = inv.targetType === "age" ? `By age ${inv.targetAge}` : inv.targetDate || "No target set";
          return (
            <div className="invest-card" key={inv.id}>
              <div className="invest-top">
                <div>
                  <div className="invest-name">{inv.name}</div>
                  <div className="invest-date">{target}</div>
                </div>
                <div className="invest-pct">{pct}%</div>
              </div>
              <div className="invest-track">
                <div><div className="invest-track-lbl">Current</div><div className="invest-track-val">{fmt(cur)}</div></div>
                <div style={{textAlign:"right"}}><div className="invest-track-lbl">Goal</div><div className="invest-track-val">{fmt(goal)}</div></div>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{width:`${pct}%`}}/>
              </div>
              {inv.notes && <div style={{fontSize:12,color:"var(--muted)",marginBottom:10}}>{inv.notes}</div>}
              <div className="invest-actions">
                <button className="bill-action-btn btn-edit" onClick={()=>{setEditing(inv);setShowForm(true);}}>Edit</button>
                <button className="bill-action-btn btn-delete" onClick={()=>onDeleteInvest(inv.id)}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>

      <button className="fab" onClick={()=>{setEditing(null);setShowForm(true);}}>+</button>

      {showForm && (
        <InvestForm
          inv={editing || EMPTY_INVEST}
          onSave={handleSave}
          onCancel={()=>{setShowForm(false);setEditing(null);}}
        />
      )}
    </div>
  );
}


// ─── AccountsScreen ───────────────────────────────────────────────────────────

const ROLE_COLORS = { spending_bank:"#00D4AA", bills_bank:"#9B88FF", credit_card:"#F5A623", holding:"var(--muted)" };
const ROLE_LABELS = { spending_bank:"Spending", bills_bank:"Bills", credit_card:"Credit Card", holding:"Holding" };

function AccountsScreen({ accounts, snapshots, onSetRole, onReorder,
                          onRemoveAccount, onAddAccount, onSetDueDay, latestBalance }) {
  const [newLabel, setNewLabel] = useState("");
  const [newLast4, setNewLast4] = useState("");
  const [newRole,  setNewRole]  = useState("spending_bank");
  const [expandId, setExpandId] = useState(null);

  const spendingBanks = accounts.filter(a => a.role === "spending_bank").sort((a,b) => (a.incomeRank??99)-(b.incomeRank??99));
  const billsBanks    = accounts.filter(a => a.role === "bills_bank");
  const creditCards   = accounts.filter(a => a.role === "credit_card");
  const holdingAccts  = accounts.filter(a => a.role === "holding");
  const incomeAccts   = spendingBanks;
  const spendingAccts = creditCards;

  function handleAdd() {
    const l4 = newLast4.replace(/\D/g,"").slice(-4);
    if (l4.length !== 4 || !newLabel.trim()) return;
    onAddAccount(l4, newLabel.trim(), newRole);
    setNewLabel(""); setNewLast4("");
  }

  function AccountRow({ a, i, totalInRole }) {
    const bal = latestBalance(a.last4);
    const color = ROLE_COLORS[a.role] || "var(--muted)";
    const expanded = expandId === a.last4;
    return (
      <div style={{
        background:"var(--card)", border:`1px solid ${expanded ? color+"60" : "var(--border)"}`,
        borderRadius:14, marginBottom:8, overflow:"hidden",
        transition:"border-color .2s"
      }}>
        {/* Main row */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",cursor:"pointer"}}
          onClick={()=>setExpandId(expanded ? null : a.last4)}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:color,flexShrink:0}}/>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:"var(--text)"}}>{a.label}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>
                •••• {a.last4}
                <span style={{marginLeft:8,fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:8,
                  background:color+"20",color:color}}>{ROLE_LABELS[a.role]}</span>
                {a.role==="spending_bank" && <span style={{marginLeft:6,fontSize:10,color:"var(--muted2)"}}>{rankName(a.incomeRank)}</span>}
              </div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {bal !== null
              ? <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:"var(--text)"}}>{fmt(bal)}</div>
              : <div style={{fontSize:13,color:"var(--muted2)"}}>—</div>}
            <div style={{fontSize:12,color:"var(--muted2)"}}>{expanded?"▲":"▼"}</div>
          </div>
        </div>

        {/* Expanded controls */}
        {expanded && (
          <div style={{borderTop:"1px solid var(--border)",padding:"12px 16px",display:"flex",flexDirection:"column",gap:10}}>
            {/* Role switcher */}
            <div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:6,letterSpacing:"1px",textTransform:"uppercase"}}>Role</div>
              <div style={{display:"flex",gap:6}}>
                {["spending_bank","bills_bank","credit_card","holding"].map(r=>(
                  <button key={r} onClick={()=>onSetRole(a.last4,r)}
                    style={{padding:"5px 12px",borderRadius:20,border:"none",cursor:"pointer",
                      fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,
                      background: a.role===r ? (ROLE_COLORS[r]||"var(--muted)") : (ROLE_COLORS[r]||"var(--muted)")+"20",
                      color: a.role===r ? "var(--bg)" : (ROLE_COLORS[r]||"var(--muted)")}}>
                    {ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>

            {/* Income rank reorder */}
            {a.role==="spending_bank" && (
              <div>
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:6,letterSpacing:"1px",textTransform:"uppercase"}}>Priority</div>
                <div style={{display:"flex",gap:6}}>
                  {i > 0 && <button className="pill pill-up" onClick={()=>onReorder(a.last4,"up")}>↑ Move up</button>}
                  {i < totalInRole-1 && <button className="pill pill-down" onClick={()=>onReorder(a.last4,"down")}>↓ Move down</button>}
                </div>
              </div>
            )}

            {/* Due day for spending */}
            {a.role==="credit_card" && (
              <div>
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:6,letterSpacing:"1px",textTransform:"uppercase"}}>Due Day</div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <input className="text-input" style={{maxWidth:80,padding:"7px 10px",fontSize:13}}
                    placeholder="e.g. 15" type="number" inputMode="numeric" min="1" max="31"
                    defaultValue={a.dueDay??""} key={a.last4+"_due"}
                    onBlur={e=>onSetDueDay(a.last4,e.target.value||null)}/>
                  <span style={{fontSize:12,color:"var(--muted2)"}}>of each month</span>
                </div>
              </div>
            )}

            {/* Float for spending_bank and bills_bank */}
            {(a.role==="spending_bank" || a.role==="bills_bank") && (
              <div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{fontSize:11,color:"var(--muted)",letterSpacing:"1px",textTransform:"uppercase"}}>Operating Float</div>
                  <button className={`toggle ${a.floatEnabled!==false?"on":"off"}`}
                    onClick={()=>onSetDueDay(a.last4+"_floatEnabled",a.floatEnabled===false?"on":"off")}>
                    <div className="toggle-knob"/>
                  </button>
                </div>
                {a.floatEnabled!==false && (
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <input className="text-input" style={{maxWidth:70,padding:"7px 10px",fontSize:13}}
                      placeholder="1.5" type="number" inputMode="decimal" step="0.1"
                      defaultValue={a.floatMultiplier??1.5} key={a.last4+"_float"}
                      onBlur={e=>onSetDueDay(a.last4+"_float",e.target.value||"1.5")}/>
                    <span style={{fontSize:12,color:"var(--muted2)"}}>× monthly flow target</span>
                  </div>
                )}
              </div>
            )}

            {/* Remove */}
            <button className="pill pill-red" style={{alignSelf:"flex-start"}}
              onClick={()=>{onRemoveAccount(a.last4);setExpandId(null);}}>
              Remove account
            </button>
          </div>
        )}
      </div>
    );
  }

  const allSorted = [
    ...spendingBanks,
    ...billsBanks,
    ...creditCards,
    ...holdingAccts,
  ];

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Accounts</div>
        <div style={{fontSize:13,color:"var(--muted)"}}>{accounts.length} total</div>
      </div>

      <div style={{padding:"0 16px",marginBottom:24}}>
        {allSorted.length === 0 && (
          <div className="history-empty">No accounts yet.<br/>Add your first account below.</div>
        )}
        {allSorted.map((a,i) => {
          const inRole = a.role==="spending_bank" ? spendingBanks : a.role==="bills_bank" ? billsBanks : a.role==="credit_card" ? creditCards : holdingAccts;
          const idxInRole = inRole.findIndex(x=>x.last4===a.last4);
          return <AccountRow key={a.last4} a={a} i={idxInRole} totalInRole={inRole.length}/>;
        })}
      </div>

      {/* Add Account */}
      <div className="section-label">Add Account</div>
      <div className="add-form">
        <div className="add-form-title">New Account</div>
        <div className="role-toggle">
          {["spending_bank","bills_bank","credit_card","holding"].map(r=>(
            <button key={r} className={`role-btn ${newRole===r?"active":""}`} onClick={()=>setNewRole(r)}>
              {ROLE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="input-row" style={{marginBottom:10}}>
          <input className="text-input" placeholder="Label (e.g. Chase Checking)"
            value={newLabel} onChange={e=>setNewLabel(e.target.value)}/>
        </div>
        <div className="input-row">
          <input className="text-input" placeholder="Last 4 digits" value={newLast4}
            maxLength={4} onChange={e=>setNewLast4(e.target.value)} inputMode="numeric"/>
          <button className="add-btn" onClick={handleAdd}>Add</button>
        </div>
      </div>
    </div>
  );
}


// ─── HoldingsTab ─────────────────────────────────────────────────────────────
// Accounts with role "holding" — balances visible, not in Safe-to-Spend calc

function HoldingsTab({ accounts, snapshots, investments, latestBalance, investThresholds,
                       onAddInvest, onEditInvest, onDeleteInvest }) {
  const holdingAccts = accounts.filter(a => a.role === "holding");
  const totalHeld    = holdingAccts.reduce((s,a) => s + (latestBalance(a.last4)??0), 0);
  const totalGoal    = investments.reduce((s,i) => s + (parseFloat(i.goal)||0), 0);
  const totalInvested= investments.reduce((s,i) => s + (parseFloat(i.current)||0), 0);
  const overallPct   = totalGoal > 0 ? Math.min(100, Math.round((totalInvested/totalGoal)*100)) : 0;

  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);
  function handleSave(v) {
    if (v.id) onEditInvest(v); else onAddInvest(v);
    setShowForm(false); setEditing(null);
  }

  return (
    <div className="screen">
      <div className="header">
        <div className="header-label">Investments</div>
        <div style={{fontSize:13,color:"var(--muted)"}}>{overallPct}% to goal</div>
      </div>

      {/* Total holdings hero */}
      <div className="invest-tab-hero">
        <div className="invest-total-label">Total Holdings</div>
        <div className="invest-total-val" style={{color: (() => {
          const pct = overallPct;
          const g=parseInt(investThresholds?.green||75), y=parseInt(investThresholds?.yellow||40), r=parseInt(investThresholds?.red||10);
          return pct>=g?"#00D4AA":pct>=y?"#F5C842":pct>=r?"#F5A623":"#FF6B6B";
        })()}}>{fmtShort(totalHeld)}</div>
        <div className="invest-total-sub">
          {holdingAccts.length} account{holdingAccts.length!==1?"s":""} · not counted in Safe to Spend
        </div>
        {totalGoal > 0 && (
          <>
            <div style={{marginTop:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:12,color:"var(--muted)"}}>Overall goal progress</span>
                <span style={{fontSize:12,color:"var(--positive)",fontFamily:"'Space Grotesk',monospace"}}>{overallPct}%</span>
              </div>
              <div className="progress-bar" style={{height:8}}>
                <div className="progress-fill" style={{width:`${overallPct}%`}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                <span style={{fontSize:11,color:"var(--muted)"}}>{fmt(totalInvested)} invested</span>
                <span style={{fontSize:11,color:"var(--muted)"}}>{fmt(totalGoal)} goal</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Holding account balances */}
      {holdingAccts.length > 0 && (
        <>
          <div className="section-label">Accounts</div>
          <div className="holding-list">
            {holdingAccts.map(a => {
              const bal = latestBalance(a.last4);
              // Match to investment goal
              const goal = investments.find(i => i.linkedAcct === a.last4);
              const pct  = goal && parseFloat(goal.goal)>0
                ? Math.min(100,Math.round(((bal??0)/parseFloat(goal.goal))*100)) : null;
              return (
                <div className="holding-card" key={a.last4}>
                  <div>
                    <div className="holding-label">{a.label}</div>
                    <div className="holding-last4">•••• {a.last4}</div>
                    {goal && <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>Goal: {fmt(parseFloat(goal.goal)||0)}</div>}
                  </div>
                  <div style={{textAlign:"right"}}>
                    {bal !== null
                      ? <div className="holding-bal">{fmt(bal)}</div>
                      : <div style={{fontSize:13,color:"var(--muted2)"}}>No balance</div>}
                    {pct !== null && <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{pct}%</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {holdingAccts.length === 0 && (
        <div className="history-empty">
          No investment accounts yet.<br/>
          Add accounts in Settings and set their role to "Holding".
        </div>
      )}

      {/* Investment Goals */}
      <div className="section-label">Goals</div>
      <div className="invest-list" style={{marginBottom:100}}>
        {investments.length === 0 && (
          <div className="history-empty" style={{padding:"24px 0"}}>No goals yet. Tap + to add one.</div>
        )}
        {investments.map(inv => {
          const cur  = parseFloat(inv.current) || 0;
          const goal = parseFloat(inv.goal) || 0;
          const pct  = goal > 0 ? Math.min(100, Math.round((cur/goal)*100)) : 0;
          const target = inv.targetType==="age" ? `By age ${inv.targetAge}` : inv.targetDate||"No target set";
          return (
            <div className="invest-card" key={inv.id}>
              <div className="invest-top">
                <div>
                  <div className="invest-name">{inv.name}</div>
                  <div className="invest-date">{target}</div>
                </div>
                <div className="invest-pct">{pct}%</div>
              </div>
              <div className="invest-track">
                <div><div className="invest-track-lbl">Current</div><div className="invest-track-val">{fmt(cur)}</div></div>
                <div style={{textAlign:"right"}}><div className="invest-track-lbl">Goal</div><div className="invest-track-val">{fmt(goal)}</div></div>
              </div>
              <div className="progress-bar"><div className="progress-fill" style={{width:`${pct}%`}}/></div>
              {inv.notes && <div style={{fontSize:12,color:"var(--muted)",marginBottom:10}}>{inv.notes}</div>}
              <div className="invest-actions">
                <button className="bill-action-btn btn-edit" onClick={()=>{setEditing(inv);setShowForm(true);}}>Edit</button>
                <button className="bill-action-btn btn-delete" onClick={()=>onDeleteInvest(inv.id)}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>

      <button className="fab" onClick={()=>{setEditing(null);setShowForm(true);}}>+</button>
      {showForm && (
        <InvestForm inv={editing||EMPTY_INVEST} onSave={handleSave}
          onCancel={()=>{setShowForm(false);setEditing(null);}}/>
      )}
    </div>
  );
}


// ─── Error Boundary ──────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("Safe2Spend error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          background:"var(--bg)", minHeight:"100vh", display:"flex",
          flexDirection:"column", alignItems:"center", justifyContent:"center",
          padding:32, fontFamily:"'DM Sans',sans-serif", color:"var(--text)"
        }}>
          <div style={{fontSize:32,marginBottom:16}}>⚠️</div>
          <div style={{fontSize:18,fontWeight:600,marginBottom:8}}>Something went wrong</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>
            {this.state.error?.message || "An unexpected error occurred"}
          </div>
          <button onClick={()=>window.location.reload()}
            style={{background:"var(--positive)",color:"var(--bg)",border:"none",borderRadius:10,
              padding:"12px 24px",fontSize:14,fontWeight:700,cursor:"pointer"}}>
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function Safe2SpendApp() {
  const [tab, setTab]               = useState("spending");
  const [theme, setTheme]           = useState(() => {
    const t = localStorage.getItem("s2s_theme") || "warm";
    return t;
  });
  const [accounts, setAccounts]     = useState(() => load("s2s_accounts",      DEFAULT_ACCOUNTS));
  const [snapshots, setSnapshots]   = useState(() => load("s2s_snapshots",     DEFAULT_SNAPSHOTS));
  const [thresholds, setThresholds] = useState(() => load("s2s_thresholds",    DEFAULT_THRESHOLDS));
  const [thresholdMode, setThresholdMode] = useState(() => load("s2s_tmode",   DEFAULT_THRESHOLD_MODE));
  const [dueThresholds,    setDueThresholds]    = useState(() => load("s2s_due_thr",    DEFAULT_DUE_THRESHOLDS));
  const [investThresholds, setInvestThresholds] = useState(() => load("s2s_inv_thr",   DEFAULT_INVEST_THRESHOLDS));

  const [bills,       setBills]       = useState(() => load("s2s_bills",       []));
  const [paycheck,    setPaycheck]    = useState(() => load("s2s_paycheck",    { netPay:"", frequency:"biweekly", nextPayDate:"" }));
  const [billsOverride, setBillsOverride] = useState(() => load("s2s_bills_override", null));
  const [roadmap,     setRoadmap]     = useState(() => load("s2s_roadmap",     DEFAULT_ROADMAP));
    const [investments, setInvestments] = useState(() => load("s2s_investments", []));
  const [heroKey, setHeroKey]       = useState(0);
  const [smsText, setSmsText]       = useState("");
  const [parseRules, setParseRules] = useState(() => load("s2s_parse_rules", []));
  const [smsResult, setSmsResult]   = useState(null);
  const [manualAcct, setManualAcct] = useState("");
  const [manualBal, setManualBal]   = useState("");
  const [toast, setToast]           = useState(null);
  const toastRef = useRef();
  const _swipeX   = useRef(0);

  // Persist to localStorage via wrapper setters below
  function setAccountsP(v)      { const val = typeof v === "function" ? v(accounts)  : v; save("s2s_accounts",   val); setAccounts(val);      }
  function setSnapshotsP(v)     { const val = typeof v === "function" ? v(snapshots) : v; save("s2s_snapshots",  val); setSnapshots(val);     }
  function setThresholdsP(v)    { const val = typeof v === "function" ? v(thresholds): v; save("s2s_thresholds", val); setThresholds(val);    }
  function setThresholdModeP(v) { const val = typeof v === "function" ? v(thresholdMode):v; save("s2s_tmode",   val); setThresholdMode(val); }
  function setDueThresholdsP(v)    { const val = typeof v === "function" ? v(dueThresholds):v;    save("s2s_due_thr",    val); setDueThresholds(val);    }
  function setInvestThresholdsP(v) { const val = typeof v === "function" ? v(investThresholds):v; save("s2s_inv_thr",   val); setInvestThresholds(val); }
  function setBillsP(v)          { const val = typeof v === "function" ? v(bills):v;          save("s2s_bills",       val); setBills(val);         }
  function setParseRulesP(v) { const val = typeof v==="function"?v(parseRules):v; save("s2s_parse_rules",val); setParseRules(val); }
  function setPaycheckP(v)          { const val = typeof v === "function" ? v(paycheck):v;       save("s2s_paycheck",       val); setPaycheck(val);         }
  function setBillsOverrideP(v)     { const val = typeof v === "function" ? v(billsOverride):v;  save("s2s_bills_override", val); setBillsOverride(val);    }
  function setRoadmapP(v)        { const val = typeof v === "function" ? v(roadmap):v;        save("s2s_roadmap",     val); setRoadmap(val);       }
  function setInvestmentsP(v)    { const val = typeof v === "function" ? v(investments):v;    save("s2s_investments", val); setInvestments(val);   }

  function handleSetTheme(t) {
    applyTheme(t);
    setTheme(t);
    localStorage.setItem("s2s_theme", t);
  }

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
    const text = smsText.trim();
    // High-priority custom rules first
    let result = runCustomRules(text, parseRules, "high");
    // Built-in patterns
    if (!result) result = parseSMS(text);
    // Low-priority custom rules last
    if (!result) result = runCustomRules(text, parseRules, "low");
    if (!result) { setSmsResult({ ok:false, msg:"Couldn't parse a balance. Check the format or add a custom rule in Settings." }); return; }

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
      const nextRank = accounts.filter(a => a.role === "spending_bank").length;
      setAccountsP(prev => [...prev, { last4: result.accountLast4, label: result.label + " •" + result.accountLast4, role: "spending_bank", incomeRank: nextRank }]);
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
          const maxRank = Math.max(-1, ...prev.filter(x => x.role === "spending_bank" && x.last4 !== last4).map(x => x.incomeRank));
          return { ...a, role: "spending_bank", incomeRank: maxRank + 1 };
        }
        if (newRole === "holding") return { ...a, role: "holding", incomeRank: null };
        return { ...a, role: "credit_card", incomeRank: null };
      });
      return rerank(updated);
    });
    setHeroKey(k => k + 1);
    showToast("Account role updated");
  }

  function rerank(accts) {
    const income = accts.filter(a => a.role === "spending_bank").sort((a,b) => (a.incomeRank ?? 99) - (b.incomeRank ?? 99));
    let rank = 0;
    return accts.map(a => {
      if (a.role !== "spending_bank") return a;
      const r = income.findIndex(x => x.last4 === a.last4);
      return { ...a, incomeRank: r };
    });
  }

  function handleReorder(last4, dir) {
    setAccountsP(prev => {
      const income = prev.filter(a => a.role === "spending_bank").sort((a,b) => a.incomeRank - b.incomeRank);
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

  function handleSetDueDay(key, val) {
    if (key.endsWith("_floatEnabled")) {
      const last4 = key.replace("_floatEnabled","");
      setAccountsP(prev => prev.map(a => a.last4===last4 ? {...a, floatEnabled: val==="on"} : a));
    } else if (key.endsWith("_float")) {
      const last4 = key.replace("_float","");
      setAccountsP(prev => prev.map(a => a.last4===last4 ? {...a, floatMultiplier: parseFloat(val)||1.5} : a));
    } else {
      setAccountsP(prev => prev.map(a => a.last4===key ? {...a, dueDay: val ? parseInt(val) : null} : a));
    }
  }

  function handleAddAccount(l4, label, role) {
    if (accounts.find(a => a.last4 === l4)) { showToast("Account already exists"); return; }
    const nextRank = role === "spending_bank" ? accounts.filter(a => a.role === "spending_bank").length : null;
    setAccountsP(prev => [...prev, { last4: l4, label, role, incomeRank: nextRank }]);
    showToast("Account added");
  }

  // ── Bill handlers ──────────────────────────────────────────────────────────
  function handleAddBill(b)    { const nb = {...b, id: Date.now()}; setBillsP(prev => [...prev, nb]); showToast("Bill added"); }
  function handleEditBill(b)   { setBillsP(prev => prev.map(x => x.id === b.id ? b : x)); showToast("Bill updated"); }
  function handleDeleteBill(id){ setBillsP(prev => prev.filter(x => x.id !== id)); showToast("Bill removed"); }

  // ── Investment handlers ──────────────────────────────────────────────────
  function handleAddInvest(v)    { setInvestmentsP(prev => [...prev, {...v, id: Date.now()}]); showToast("Goal added"); }
  function handleEditInvest(v)   { setInvestmentsP(prev => prev.map(x => x.id === v.id ? v : x)); showToast("Goal updated"); }
  function handleDeleteInvest(id){ setInvestmentsP(prev => prev.filter(x => x.id !== id)); showToast("Goal removed"); }

  // ── Parse rule handlers ────────────────────────────────────────────────────
  function handleAddParseRule(rule) { setParseRulesP(prev => [...prev, rule]); showToast("Parse rule added"); }
  function handleDeleteParseRule(id) { setParseRulesP(prev => prev.filter(r => r.id !== id)); showToast("Parse rule removed"); }
  function handleToggleParseRulePriority(id) {
    setParseRulesP(prev => prev.map(r => r.id === id ? { ...r, priority: r.priority === "high" ? "low" : "high" } : r));
  }

  const NAV = [
    { id:"dashboard", label:"Dashboard",Icon:IconDashboard },
    { id:"spending",  label:"Spending", Icon:IconHome      },
    { id:"bills",     label:"Bills",    Icon:IconBills     },
    { id:"invest",    label:"Invest",   Icon:IconInvest    },
    { id:"roadmap",   label:"Roadmap",  Icon:IconRoadmap   },
    { id:"accounts",  label:"Accounts", Icon:IconAccounts  },
    { id:"settings",  label:"Settings", Icon:IconSettings  },
  ];

  return (
    <>
      <style>{S}</style>
      <div className="app"
        onTouchStart={e=>{_swipeX.current=e.touches[0].clientX;}}
        onTouchEnd={e=>{
          const dx=e.changedTouches[0].clientX - _swipeX.current;
          if(Math.abs(dx)<50)return;
          const ids=NAV.map(n=>n.id);
          const cur=ids.indexOf(tab);
         // if(dx<0 && cur<ids.length-1) setTab(ids[cur+1]);
         // if(dx>0 && cur>0)            setTab(ids[cur-1]);
        }}>
        {toast && <div className="toast" key={toast}>{toast}</div>}

        {tab === "spending" && (
          <SpendingScreen
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
        {tab === "dashboard" && (
          <DashboardScreen
            safeToSpend={safeToSpend} thresholds={thresholds} thresholdMode={thresholdMode}
            firstBalance={firstBalance} accounts={accounts} bills={bills}
            paycheck={paycheck} roadmap={roadmap} snapshots={snapshots}
            latestBalance={latestBalance} dueThresholds={dueThresholds}
            billsOverride={billsOverride}
          />
        )}
        {tab === "bills" && (
          <BillsScreen
            bills={bills} accounts={accounts}
            onAddBill={handleAddBill} onEditBill={handleEditBill} onDeleteBill={handleDeleteBill}
            latestBalance={latestBalance} dueThresholds={dueThresholds}
            paycheck={paycheck} onSavePaycheck={setPaycheckP}
            billsOverride={billsOverride} onSaveBillsOverride={setBillsOverrideP}
          />
        )}

        {tab === "accounts" && (
          <AccountsScreen
            accounts={accounts} snapshots={snapshots}
            onSetRole={handleSetRole} onReorder={handleReorder}
            onRemoveAccount={handleRemoveAccount} onAddAccount={handleAddAccount}
            onSetDueDay={handleSetDueDay} latestBalance={latestBalance}
          />
        )}
        {tab === "roadmap" && (
          <KataRoadmap roadmap={roadmap} onUpdateRoadmap={setRoadmapP} />
        )}
        {tab === "invest" && (
          <HoldingsTab
            accounts={accounts} snapshots={snapshots} investments={investments}
            latestBalance={latestBalance} investThresholds={investThresholds}
            onAddInvest={handleAddInvest} onEditInvest={handleEditInvest} onDeleteInvest={handleDeleteInvest}
          />
        )}
        {tab === "settings" && (
          <SettingsScreen
            thresholds={thresholds} thresholdMode={thresholdMode}
            dueThresholds={dueThresholds} investThresholds={investThresholds}
            onSaveThresholds={setThresholdsP} onSaveThresholdMode={setThresholdModeP}
            onSaveDueThresholds={setDueThresholdsP} onSaveInvestThresholds={setInvestThresholdsP}
            snapshots={snapshots} accounts={accounts}
            bills={bills} paycheck={paycheck} billsOverride={billsOverride}
            roadmap={roadmap} investments={investments}
            setAccounts={setAccountsP} setSnapshots={setSnapshotsP}
            setBills={setBillsP} setPaycheck={setPaycheckP}
            setBillsOverride={setBillsOverrideP} setRoadmap={setRoadmapP}
            setInvestments={setInvestmentsP}
            setThresholds={setThresholdsP} setThresholdMode={setThresholdModeP}
            setDueThresholds={setDueThresholdsP} setInvestThresholds={setInvestThresholdsP}
            showToast={showToast}
            theme={theme} onSetTheme={handleSetTheme}
            parseRules={parseRules}
            onAddParseRule={handleAddParseRule}
            onDeleteParseRule={handleDeleteParseRule}
            onToggleParseRulePriority={handleToggleParseRulePriority}
          />
        )}

        <nav className="nav">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} className={`nav-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <Icon /><span className="nav-label">{label}</span>
              {tab===id && <div style={{width:4,height:4,borderRadius:"50%",background:"var(--accent)",marginTop:1}}/>}
              {tab===id && <div style={{width:3,height:3,borderRadius:"50%",background:"var(--positive)",marginTop:1}}/>}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Safe2SpendApp />
    </ErrorBoundary>
  );
}
