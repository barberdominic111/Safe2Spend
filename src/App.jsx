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

const S2S_VERSION = "v1.1";

function initStorage() {
  try {
    if (localStorage.getItem("s2s_version") !== S2S_VERSION) {
      // New version — wipe all app data so sample data loads fresh
      Object.keys(localStorage).filter(k=>k.startsWith("s2s_")).forEach(k=>localStorage.removeItem(k));
      localStorage.setItem("s2s_version", S2S_VERSION);
    }
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
  .nav { position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:430px; background:#0D1929; border-top:1px solid #1A2E4A; display:flex; overflow-x:auto; overflow-y:hidden; padding:10px 0 24px; z-index:100; scrollbar-width:none; -ms-overflow-style:none; }
  .nav::-webkit-scrollbar { display:none; }
  .nav-btn { flex:0 0 auto; min-width:60px; display:flex; flex-direction:column; align-items:center; gap:3px; background:none; border:none; cursor:pointer; padding:4px 8px; }
  .nav-icon { width:18px; height:18px; }
  .nav-label { font-family:'DM Sans',sans-serif; font-size:9px; font-weight:500; letter-spacing:0.5px; text-transform:uppercase; transition:color .15s; }
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

  /* ── Dashboard ── */
  .dash-grid { padding:0 16px; display:flex; flex-direction:column; gap:12px; margin-bottom:24px; }
  .dash-card { background:#111E33; border:1px solid #1A2E4A; border-radius:16px; padding:18px 20px; }
  .dash-card-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#2E4A6A; margin-bottom:8px; }
  .dash-card-value { font-family:'Space Grotesk',monospace; font-size:36px; font-weight:700; line-height:1; }
  .dash-card-sub   { font-size:12px; color:#4A6280; margin-top:6px; }
  .dash-row { display:flex; gap:10px; }
  .dash-half { flex:1; }
  .dash-card.small .dash-card-value { font-size:22px; }
  .upcoming-list { display:flex; flex-direction:column; gap:0; margin-top:4px; }
  .upcoming-item { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #1A2E4A; }
  .upcoming-item:last-child { border-bottom:none; }
  .upcoming-name { font-size:13px; color:#C8D8E8; }
  .upcoming-due  { font-size:11px; color:#4A6280; margin-top:2px; }
  .upcoming-amt  { font-family:'Space Grotesk',monospace; font-size:14px; font-weight:600; color:#E8EEF6; }
  .suggest-card { background:#0D1F35; border:1px solid #00D4AA28; border-radius:16px; padding:18px 20px; margin:0 16px 16px; }
  .suggest-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#00D4AA; margin-bottom:6px; }
  .suggest-title { font-size:16px; font-weight:600; color:#E8EEF6; margin-bottom:4px; }
  .suggest-reason { font-size:12px; color:#4A6280; line-height:1.5; }

  /* ── Bills ── */
  .bill-list { padding:0 16px; display:flex; flex-direction:column; gap:8px; margin-bottom:80px; }
  .bill-card { background:#111E33; border:1px solid #1A2E4A; border-radius:14px; padding:16px 18px; }
  .bill-card-top { display:flex; justify-content:space-between; align-items:flex-start; }
  .bill-name { font-size:15px; font-weight:600; color:#E8EEF6; }
  .bill-meta { font-size:12px; color:#4A6280; margin-top:3px; line-height:1.6; }
  .bill-amount { font-family:'Space Grotesk',monospace; font-size:20px; font-weight:700; color:#E8EEF6; text-align:right; }
  .bill-amount-sub { font-size:11px; color:#4A6280; text-align:right; margin-top:2px; }
  .bill-tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
  .bill-tag { font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; }
  .tag-auto   { background:#00D4AA18; color:#00D4AA; }
  .tag-fixed  { background:#9B88FF18; color:#9B88FF; }
  .tag-var    { background:#F5A62318; color:#F5A623; }
  .tag-ef     { background:#F5C84218; color:#F5C842; }
  .tag-retire { background:#7B68EE18; color:#9B88FF; }
  .bill-actions { display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid #1A2E4A; }
  .bill-action-btn { flex:1; padding:8px; border-radius:10px; border:none; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:600; cursor:pointer; }
  .btn-edit   { background:#1A2E4A; color:#C8D8E8; }
  .btn-delete { background:#FF6B6B18; color:#FF6B6B; }
  .fab { position:fixed; bottom:90px; right:20px; width:52px; height:52px; border-radius:26px; background:#00D4AA; border:none; color:#0A1628; font-size:26px; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 20px #00D4AA40; z-index:50; }
  .modal-overlay { position:fixed; inset:0; background:#000000CC; z-index:200; display:flex; align-items:flex-end; }
  .modal { background:#0D1929; border-radius:20px 20px 0 0; padding:24px 20px 40px; width:100%; max-height:90vh; overflow-y:auto; }
  .modal-title { font-size:18px; font-weight:600; color:#E8EEF6; font-family:'Space Grotesk',sans-serif; margin-bottom:20px; }
  .form-label { font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#4A6280; margin-bottom:6px; display:block; }
  .form-group { margin-bottom:16px; }
  .form-row { display:flex; gap:10px; }
  .form-row .form-group { flex:1; }
  .form-input { width:100%; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:14px; padding:11px 13px; outline:none; transition:border-color .2s; }
  .form-input:focus { border-color:#9B88FF; }
  .form-input::placeholder { color:#2E4A6A; }
  .form-select { width:100%; background:#0A1628; border:1px solid #1A2E4A; border-radius:10px; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:14px; padding:11px 13px; outline:none; appearance:none; cursor:pointer; }
  .form-toggle-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #1A2E4A; }
  .form-toggle-label { font-size:14px; color:#C8D8E8; }
  .toggle { width:42px; height:24px; border-radius:12px; border:none; cursor:pointer; position:relative; transition:background .2s; flex-shrink:0; }
  .toggle.on  { background:#00D4AA; }
  .toggle.off { background:#1A2E4A; }
  .toggle-knob { width:18px; height:18px; border-radius:9px; background:#fff; position:absolute; top:3px; transition:left .2s; }
  .toggle.on  .toggle-knob { left:21px; }
  .toggle.off .toggle-knob { left:3px; }
  .form-save-btn { width:100%; margin-top:20px; background:#00D4AA; color:#0A1628; border:none; border-radius:12px; padding:14px; font-family:'DM Sans',sans-serif; font-size:15px; font-weight:700; cursor:pointer; }
  .form-cancel-btn { width:100%; margin-top:10px; background:transparent; color:#4A6280; border:none; padding:12px; font-family:'DM Sans',sans-serif; font-size:14px; cursor:pointer; }

  /* ── Paycheck Planner ── */
  .planner-hero { background:#111E33; border:1px solid #1A2E4A; border-radius:16px; padding:24px 20px; margin:0 16px 16px; }
  .planner-row { display:flex; justify-content:space-between; align-items:baseline; padding:8px 0; border-bottom:1px solid #1A2E4A; }
  .planner-row:last-child { border-bottom:none; }
  .planner-lbl { font-size:13px; color:#4A6280; }
  .planner-val { font-family:'Space Grotesk',monospace; font-size:26px; font-weight:700; }
  .planner-section { padding:0 16px; margin-bottom:28px; }
  .planner-bill-row { background:#111E33; border:1px solid #1A2E4A; border-radius:12px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .planner-bill-name { font-size:14px; color:#C8D8E8; }
  .planner-bill-sub  { font-size:11px; color:#4A6280; margin-top:2px; }
  .planner-bill-amt  { font-family:'Space Grotesk',monospace; font-size:16px; font-weight:600; color:#E8EEF6; }

  /* ── Roadmap ── */
  .roadmap-container { padding:16px 16px 100px; }
  .roadmap-step { display:flex; gap:14px; align-items:flex-start; }
  .step-spine { display:flex; flex-direction:column; align-items:center; width:16px; flex-shrink:0; }
  .step-dot { width:16px; height:16px; border-radius:8px; flex-shrink:0; border:2px solid transparent; }
  .step-dot.done    { background:#00D4AA; border-color:#00D4AA; }
  .step-dot.current { background:#0A1628; border-color:#00D4AA; box-shadow:0 0 0 3px #00D4AA30; }
  .step-dot.future  { background:#1A2E4A; border-color:#1A2E4A; }
  .step-line { width:2px; flex:1; min-height:20px; margin:3px 0; }
  .step-line.done   { background:#00D4AA40; }
  .step-line.future { background:#1A2E4A; }
  .step-body { flex:1; padding-bottom:16px; }
  .step-label { font-size:15px; font-weight:600; margin-bottom:4px; }
  .step-label.done    { color:#4A6280; }
  .step-label.current { color:#E8EEF6; }
  .step-label.future  { color:#2E4A6A; }
  .step-badge { font-size:10px; font-weight:600; letter-spacing:1px; padding:2px 8px; border-radius:10px; display:inline-block; margin-bottom:6px; }
  .badge-current { background:#00D4AA20; color:#00D4AA; }
  .badge-done    { background:#1A2E4A; color:#4A6280; }
  .roadmap-actions { display:flex; gap:6px; flex-wrap:wrap; }
  .roadmap-btn { font-size:11px; padding:4px 10px; border-radius:8px; border:none; font-family:'DM Sans',sans-serif; font-weight:600; cursor:pointer; }
  .rmbtn-done    { background:#00D4AA20; color:#00D4AA; }
  .rmbtn-current { background:#9B88FF20; color:#9B88FF; }
  .rmbtn-del     { background:#FF6B6B18; color:#FF6B6B; }
  .rmbtn-up      { background:#1A2E4A; color:#C8D8E8; }
  .rmbtn-down    { background:#1A2E4A; color:#C8D8E8; }

  /* ── Investment Goals ── */
  .invest-list { padding:0 16px; display:flex; flex-direction:column; gap:10px; margin-bottom:80px; }
  .invest-card { background:#111E33; border:1px solid #1A2E4A; border-radius:14px; padding:18px; }
  .invest-top  { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
  .invest-name { font-size:15px; font-weight:600; color:#E8EEF6; }
  .invest-date { font-size:11px; color:#4A6280; margin-top:3px; }
  .invest-pct  { font-family:'Space Grotesk',monospace; font-size:28px; font-weight:700; color:#00D4AA; }
  .invest-track { display:flex; justify-content:space-between; margin-bottom:6px; }
  .invest-track-lbl { font-size:11px; color:#4A6280; }
  .invest-track-val { font-family:'Space Grotesk',monospace; font-size:13px; color:#C8D8E8; }
  .progress-bar  { height:6px; border-radius:3px; background:#1A2E4A; overflow:hidden; margin-bottom:12px; }
  .progress-fill { height:100%; border-radius:3px; background:#00D4AA; transition:width .5s ease; }
  .invest-actions { display:flex; gap:8px; padding-top:12px; border-top:1px solid #1A2E4A; }

  /* ── Roadmap visual ── */
  .roadmap-visual { position:relative; padding:20px 16px 40px; overflow:hidden; }
  .road-svg { width:100%; display:block; }
  .milestone-popup { position:absolute; background:#111E33; border:1px solid #1A2E4A; border-radius:10px; padding:8px 12px; font-size:12px; color:#C8D8E8; max-width:140px; pointer-events:none; }
  .milestone-popup.done    { border-color:#00D4AA40; }
  .milestone-popup.current { border-color:#00D4AA; box-shadow:0 0 12px #00D4AA30; }
  .milestone-popup.future  { opacity:0.5; }
  .milestone-date { font-size:10px; color:#4A6280; margin-top:3px; }
  .roadmap-edit-date { font-size:11px; color:#9B88FF; cursor:pointer; text-decoration:underline; }

  /* ── Bills list view ── */
  .view-toggle { display:flex; gap:6px; padding:0 16px 16px; }
  .view-btn { flex:1; padding:8px; border-radius:10px; border:1px solid #1A2E4A; background:#0A1628; color:#4A6280; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; text-align:center; }
  .view-btn.active { background:#1A2E4A; color:#E8EEF6; border-color:#2E4A6A; }
  .bills-table { width:100%; border-collapse:collapse; font-size:13px; }
  .bills-table th { text-align:left; padding:8px 12px; font-size:10px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#2E4A6A; border-bottom:1px solid #1A2E4A; }
  .bills-table td { padding:12px; border-bottom:1px solid #111E33; color:#C8D8E8; vertical-align:middle; }
  .bills-table tr:last-child td { border-bottom:none; }
  .bills-table tr:hover td { background:#111E3320; }
  .bills-table-wrap { margin:0 16px 80px; background:#111E33; border:1px solid #1A2E4A; border-radius:14px; overflow:hidden; overflow-x:auto; }
  .tbl-input { background:transparent; border:none; color:#C8D8E8; font-family:'DM Sans',sans-serif; font-size:13px; width:100%; outline:none; padding:2px 0; }
  .tbl-input:focus { border-bottom:1px solid #9B88FF; }

  /* ── Float on income accounts ── */
  .float-row { display:flex; align-items:center; gap:10px; padding:8px 0; }
  .float-status { display:flex; align-items:center; gap:6px; }
  .float-bar { height:4px; border-radius:2px; background:#1A2E4A; overflow:hidden; flex:1; min-width:60px; }
  .float-fill { height:100%; border-radius:2px; transition:width .4s ease; }

  /* ── Investment tab ── */
  .invest-tab-hero { background:#111E33; border:1px solid #1A2E4A; border-radius:16px; padding:24px 20px; margin:0 16px 16px; }
  .invest-total-label { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#2E4A6A; margin-bottom:8px; }
  .invest-total-val { font-family:'Space Grotesk',monospace; font-size:52px; font-weight:700; color:#00D4AA; line-height:1; }
  .invest-total-sub { font-size:12px; color:#4A6280; margin-top:6px; }
  .holding-list { padding:0 16px; display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
  .holding-card { background:#111E33; border:1px solid #1A2E4A; border-radius:14px; padding:16px 18px; display:flex; justify-content:space-between; align-items:center; }
  .holding-label { font-size:14px; font-weight:500; color:#C8D8E8; }
  .holding-last4  { font-size:12px; color:#4A6280; margin-top:2px; }
  .holding-bal    { font-family:'Space Grotesk',monospace; font-size:18px; font-weight:600; color:#00D4AA; }
`;

// ─── Rank dot colors ──────────────────────────────────────────────────────────

const RANK_COLORS = ["#00D4AA", "#9B88FF", "#F5C842", "#F5A623"];
function rankColor(r) { return RANK_COLORS[r % RANK_COLORS.length]; }

// ─── Icons ────────────────────────────────────────────────────────────────────

const IconDashboard = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);
const IconBills = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
  </svg>
);
const IconPlanner = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
    <path d="M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/>
  </svg>
);
const IconRoadmap = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
    <circle cx="12" cy="9" r="2.5"/>
  </svg>
);

const IconAccounts = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="7" r="4"/>
    <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/>
    <path d="M16 3.13a4 4 0 010 7.75"/>
    <path d="M21 21v-2a4 4 0 00-3-3.87"/>
  </svg>
);

const IconInvest = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* body */}
    <path d="M20.5 11c0-4.14-3.58-7.5-8-7.5S4.5 6.86 4.5 11c0 1.64.55 3.16 1.47 4.41L5 18h2l.75 2h3l.5-2h1.5l.5 2h3L17 18h1.5l-.97-2.59A7.44 7.44 0 0020.5 11z"/>
    {/* coin slot */}
    <line x1="12.5" y1="5" x2="12.5" y2="7.5"/>
    {/* eye */}
    <circle cx="16" cy="10.5" r="0.9" fill="currentColor" stroke="none"/>
    {/* ear / snout */}
    <ellipse cx="8" cy="12" rx="1.5" ry="1" strokeWidth="1.4"/>
    {/* tail */}
    <path d="M20.5 10.5c1.2-.2 2 .4 2 1.2s-.8 1.3-2 1.1" strokeWidth="1.4"/>
  </svg>
);

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

      {/* Hero */}
      <div className="hero">
        <div className="hero-eyebrow">Safe to spend</div>
        <div key={heroKey} className="hero-amount anim" style={{color:heroCol}}>
          {fmtShort(safeToSpend)}
        </div>
        <div className="hero-sub">
          {safeToSpend === null ? "Add a spending account to get started"
           : safeToSpend >= 0  ? "Your bills are paid — this is yours to spend"
           : "Credit card balances exceed your spending accounts"}
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
                    <div className="acct-rank-dot" style={{background:rankColor(a.incomeRank)}}/>
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
                    <div>
                      <div className="account-label">{a.label}</div>
                      <div className="account-last4">•••• {a.last4}</div>
                      {dateStr
                        ? <span className="rank-badge" style={{background:dc?dc+"20":"#1A2E4A",color:dc??"#4A6280",marginTop:4}}>
                            Due {dateStr}{days!==null && ` · ${days}d`}
                          </span>
                        : <span className="rank-badge" style={{background:"#1A2E4A",color:"#2E4A6A"}}>No due date</span>}
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
            <span style={{fontSize:12,color:"#4A6280"}}>Total on cards</span>
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
          <div className="sms-result" style={{background:"#9B88FF14",color:"#C8D8E8"}}>
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

function SettingsScreen({ thresholds, thresholdMode,
                          dueThresholds, investThresholds,
                          onSaveThresholds, onSaveThresholdMode,
                          onSaveDueThresholds, onSaveInvestThresholds,
                          snapshots, accounts }) {
  const [tHi,  setTHi]  = useState(thresholds.hi);
  const [tMid, setTMid] = useState(thresholds.mid);
  const [tLo,  setTLo]  = useState(thresholds.lo);
  const [tMode, setTMode] = useState(thresholdMode);
  const [dGreen,  setDGreen]  = useState(dueThresholds.green);
  const [dYellow, setDYellow] = useState(dueThresholds.yellow);
  const [dRed,    setDRed]    = useState(dueThresholds.red);
  const [iGreen,  setIGreen]  = useState(investThresholds.green);
  const [iYellow, setIYellow] = useState(investThresholds.yellow);
  const [iRed,    setIRed]    = useState(investThresholds.red);

  function handleSave() {
    onSaveThresholds({ hi: tHi, mid: tMid, lo: tLo });
    onSaveThresholdMode(tMode);
    onSaveDueThresholds({ green: dGreen, yellow: dYellow, red: dRed });
    onSaveInvestThresholds({ green: iGreen, yellow: iYellow, red: iRed });
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
          {color:"#00D4AA",val:iGreen, set:setIGreen, ph:"e.g. 75"},
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
        <div style={{fontSize:11,color:"#2E4A6A",marginBottom:12,paddingLeft:22}}>Below the last level shows red.</div>
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
          <rect x="30" y="82" width="160" height="8" rx="3" fill="#1A2E4A"/>
          <rect x="50" y="90" width="6" height="22" rx="2" fill="#1A2E4A"/>
          <rect x="164" y="90" width="6" height="22" rx="2" fill="#1A2E4A"/>
          {/* laptop */}
          <rect x="80" y="62" width="60" height="38" rx="4" fill="#0D1929" stroke="#2E4A6A" strokeWidth="1.5"/>
          <rect x="84" y="66" width="52" height="29" rx="2" fill="#111E33"/>
          {/* screen glow lines */}
          <rect x="88" y="70" width="30" height="2" rx="1" fill="#9B88FF" opacity="0.6"/>
          <rect x="88" y="75" width="22" height="2" rx="1" fill="#9B88FF" opacity="0.4"/>
          <rect x="88" y="80" width="26" height="2" rx="1" fill="#00D4AA" opacity="0.5"/>
          <rect x="68" y="100" width="84" height="4" rx="2" fill="#1A2E4A"/>
          {/* person */}
          <circle cx="52" cy="54" r="12" fill="#F5A623"/>
          <rect x="40" y="68" width="24" height="20" rx="4" fill="#9B88FF"/>
          {/* arm reaching to laptop */}
          <path d="M64 74 Q72 74 78 70" stroke="#F5A623" strokeWidth="3.5" strokeLinecap="round"/>
          {/* coffee */}
          <rect x="152" y="72" width="14" height="14" rx="3" fill="#1A2E4A" stroke="#2E4A6A" strokeWidth="1"/>
          <path d="M155 68 Q157 64 159 68" stroke="#4A6280" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )
    },
    car: {
      label: "Building momentum",
      color: "#F5C842",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          {/* road */}
          <rect x="0" y="90" width="220" height="30" fill="#0D1929"/>
          <rect x="0" y="88" width="220" height="4" fill="#1A2E4A"/>
          {/* road dashes */}
          {[10,50,90,130,170].map(x=><rect key={x} x={x} y="103" width="24" height="3" rx="1.5" fill="#2E4A6A"/>)}
          {/* car body */}
          <rect x="40" y="68" width="130" height="32" rx="8" fill="#9B88FF"/>
          {/* car top */}
          <path d="M70 68 Q80 44 100 42 L140 42 Q158 44 160 68Z" fill="#7B68EE"/>
          {/* windows */}
          <rect x="82" y="48" width="30" height="18" rx="3" fill="#C8D8E8" opacity="0.3"/>
          <rect x="118" y="48" width="30" height="18" rx="3" fill="#C8D8E8" opacity="0.3"/>
          {/* wheels */}
          <circle cx="78" cy="100" r="12" fill="#0A1628" stroke="#2E4A6A" strokeWidth="2"/>
          <circle cx="78" cy="100" r="5" fill="#1A2E4A"/>
          <circle cx="148" cy="100" r="12" fill="#0A1628" stroke="#2E4A6A" strokeWidth="2"/>
          <circle cx="148" cy="100" r="5" fill="#1A2E4A"/>
          {/* headlights */}
          <ellipse cx="170" cy="80" rx="5" ry="4" fill="#F5C842" opacity="0.8"/>
          <path d="M175 78 L195 72 M175 82 L195 88" stroke="#F5C842" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
          {/* person in car */}
          <circle cx="110" cy="56" r="9" fill="#F5A623"/>
          {/* speed lines */}
          {[20,30,40].map((y,i)=>(
            <line key={i} x1={10} y1={y+50} x2={30} y2={y+50} stroke="#2E4A6A" strokeWidth="1.5" strokeLinecap="round" opacity={0.3+i*0.2}/>
          ))}
        </svg>
      )
    },
    mountain: {
      label: "Climbing higher",
      color: "#00D4AA",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          {/* sky gradient suggestion */}
          <rect x="0" y="0" width="220" height="120" fill="#0A1628"/>
          {/* mountain far */}
          <path d="M0 120 L60 40 L120 120Z" fill="#111E33"/>
          {/* mountain near */}
          <path d="M60 120 L140 20 L220 120Z" fill="#0D1929"/>
          {/* snow cap */}
          <path d="M130 36 L140 20 L150 36 Q140 32 130 36Z" fill="#C8D8E8" opacity="0.3"/>
          {/* path up mountain */}
          <path d="M80 120 Q100 90 115 60 Q125 40 140 20" stroke="#2E4A6A" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round"/>
          {/* person climbing */}
          <circle cx="112" cy="65" r="9" fill="#F5A623"/>
          <rect x="105" y="75" width="14" height="16" rx="3" fill="#00D4AA"/>
          {/* arm with axe/pole */}
          <line x1="119" y1="77" x2="128" y2="65" stroke="#F5A623" strokeWidth="2.5" strokeLinecap="round"/>
          <line x1="128" y1="65" x2="128" y2="55" stroke="#C8D8E8" strokeWidth="1.5" strokeLinecap="round"/>
          {/* stars */}
          {[[185,15],[195,30],[175,25],[200,10]].map(([x,y],i)=>(
            <circle key={i} cx={x} cy={y} r="1.5" fill="#4A6280" opacity={0.6}/>
          ))}
        </svg>
      )
    },
    summit: {
      label: "At the summit",
      color: "#00D4AA",
      svg: (
        <svg viewBox="0 0 220 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",maxWidth:220}}>
          <rect x="0" y="0" width="220" height="120" fill="#0A1628"/>
          {/* mountains background */}
          <path d="M0 120 L50 55 L100 120Z" fill="#111E33"/>
          <path d="M90 120 L150 30 L210 120Z" fill="#0D1929"/>
          <path d="M140 48 L150 30 L160 48 Q150 44 140 48Z" fill="#C8D8E8" opacity="0.4"/>
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
          <line x1="157" y1="55" x2="157" y2="30" stroke="#C8D8E8" strokeWidth="1.5" strokeLinecap="round"/>
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
      background:"#111E33", border:`1px solid ${s.color}20`,
      borderRadius:16, padding:"20px 20px 16px", margin:"0 16px 16px",
      textAlign:"center"
    }}>
      <div style={{marginBottom:12}}>{s.svg}</div>
      <div style={{fontSize:11,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:s.color,marginBottom:4}}>
        {s.label}
      </div>
      {currentStep && (
        <div style={{fontSize:13,color:"#C8D8E8"}}>
          Working toward: <strong>{currentStep.label}</strong>
        </div>
      )}
      <div style={{fontSize:11,color:"#2E4A6A",marginTop:4}}>
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
            Consider putting it toward: <strong style={{color:"#E8EEF6"}}>{currentStep.label}</strong>
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
        <div className="dash-row">
          <div className="dash-card dash-half small">
            <div className="dash-card-label">Next Paycheck</div>
            <div className="dash-card-value">{fmtShort(netPay)}</div>
            <div className="dash-card-sub">{freq}</div>
          </div>
          <div className="dash-card dash-half small">
            <div className="dash-card-label">Reserved</div>
            <div className="dash-card-value" style={{color:"#F5A623"}}>{fmtShort(totalReserve)}</div>
            <div className="dash-card-sub">for bills</div>
          </div>
        </div>
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
          });
          const troughCol = sim.troughLowest >= sim.warnThresh ? "#00D4AA"
                          : sim.troughLowest >= 0 ? "#F5C842" : "#FF6B6B";
          return (
            <div className="dash-card" style={{borderColor: troughCol+"30"}}>
              <div className="dash-card-label">Bills Account · Trough Forecast</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                <div>
                  <div className="dash-card-value" style={{color:troughCol}}>{fmtShort(sim.troughLowest)}</div>
                  <div className="dash-card-sub">lowest around {sim.troughDate}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:"#F5A623"}}>
                    −{fmtShort(sim.troughExposure)}
                  </div>
                  <div style={{fontSize:11,color:"#4A6280",marginTop:2}}>trough depth · {sim.mult}× float</div>
                </div>
              </div>
              {sim.troughLowest < 0 && (
                <div style={{marginTop:8,fontSize:11,color:"#FF6B6B",padding:"6px 10px",background:"#FF6B6B10",borderRadius:6}}>
                  Account would go negative — increase float or add funds
                </div>
              )}
              {sim.troughLowest >= 0 && sim.troughLowest < sim.warnThresh && (
                <div style={{marginTop:8,fontSize:11,color:"#F5C842",padding:"6px 10px",background:"#F5C84210",borderRadius:6}}>
                  Gets tight but stays positive. No room for surprises.
                </div>
              )}
            </div>
          );
        })()}

        {/* Roadmap */}
        {currentStep && (
          <div className="dash-card">
            <div className="dash-card-label">Current Milestone</div>
            <div className="dash-card-value" style={{fontSize:20, color:"#00D4AA"}}>{currentStep.label}</div>
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
// and where today sits relative to the expected cycle position.
//
// Pay cadence anchors to "today" as the most recent payday
// (or calculates the next payday from today).

const PAY_DAYS_PER_YEAR = { weekly:52, biweekly:26, semimonthly:24, monthly:12 };
const PAY_CYCLE_DAYS    = { weekly:7,  biweekly:14, semimonthly:15, monthly:30 };

function runTroughSimulation({ bills, totalBillsBal, netPay, frequency, floatMult, accounts }) {
  const freq       = frequency || "biweekly";
  const cycleLen   = PAY_CYCLE_DAYS[freq] || 14;
  const perYear    = PAY_DAYS_PER_YEAR[freq] || 26;
  const paycheckAmt = parseFloat(netPay) || 0;
  const mult       = parseFloat(floatMult) || 1.5;

  // Simulation window = floatMult × one pay cycle, minimum 30 days
  const windowDays = Math.max(30, Math.ceil(mult * cycleLen) + cycleLen);

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

  // Paycheck lands every cycleLen days from today (day 0 = today)
  // We assume today is shortly after a payday so day 0 balance = current balance
  const today = new Date();
  const todayDom = today.getDate(); // day of month today

  // Simulate day by day
  let bal = totalBillsBal;
  const days = [];
  let lowestBal  = bal;
  let lowestDay  = 0;
  let lowestDate = new Date(today);

  for (let d = 0; d < windowDays; d++) {
    const simDate = new Date(today);
    simDate.setDate(today.getDate() + d);
    const dom = simDate.getDate(); // day of month for this simulated day

    // Add paycheck on cycle boundaries (every cycleLen days after day 0)
    // Day 0 = today (just received paycheck), next on day cycleLen, etc.
    let paycheckToday = 0;
    if (d > 0 && d % cycleLen === 0 && paycheckAmt > 0) {
      paycheckToday = paycheckAmt;
      bal += paycheckAmt;
    }

    // Subtract bills due today (by day of month)
    const billsDue = billEvents[dom] || 0;
    if (billsDue > 0) bal -= billsDue;

    const dayEntry = {
      d,
      date: simDate,
      dateStr: simDate.toLocaleDateString("en-US", { month:"short", day:"numeric" }),
      bal: Math.round(bal * 100) / 100,
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
  }

  // Monthly bill total (for zone lines)
  const monthlyTotal = Object.values(billEvents).reduce((s,v)=>s+v,0);

  // Float target = (monthly bills / paychecks per month) × paychecks in float window
  // Simplified: monthly × mult (same dollar amount, different meaning)
  const paychecksPerMonth = perYear / 12;
  const billsPerPaycheck  = monthlyTotal / paychecksPerMonth;
  const floatTarget       = billsPerPaycheck * mult * paychecksPerMonth; // = monthlyTotal * mult

  // "Where are you right now in the cycle"
  // Expected balance at day 0 is totalBillsBal.
  // The trough depth = totalBillsBal - lowestBal.
  // How far into the trough today: if today's bal > lowestBal, we haven't hit it yet.
  // Trough exposure = how much lower the balance WILL get before next paycheck.
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

  return {
    days, monthlyTotal, floatTarget, safeThresh, warnThresh, dangThresh,
    troughLowest, troughExposure, troughDate, lowestDay,
    zone, zoneColor, zoneLabel,
    billsPerPaycheck, paycheckAmt, freq, cycleLen, mult, windowDays,
  };
}

// ─── BillsScaleView ──────────────────────────────────────────────────────────

function BillsScaleView({ accounts, bills, latestBalance, dueThresholds, paycheck, billsOverride, onSaveBillsOverride }) {
  const { billsBanks, totalBillsBal, monthlyTotal } = computeBillsHealth(accounts, bills, latestBalance);

  // Local override for pay settings (pulls from planner as default)
  const [localNetPay, setLocalNetPay]   = useState(billsOverride?.netPay   ?? paycheck?.netPay   ?? "");
  const [localFreq,   setLocalFreq]     = useState(billsOverride?.frequency ?? paycheck?.frequency ?? "biweekly");

  // Float multiplier from bills_bank accounts (use first one found, default 1.5)
  const floatMult = billsBanks[0]?.floatMultiplier ?? 1.5;

  const sim = billsBanks.length > 0 ? runTroughSimulation({
    bills, totalBillsBal,
    netPay: localNetPay,
    frequency: localFreq,
    floatMult,
    accounts,
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
      <div style={{background:"#0D1F35",border:"1px solid #1A3A5A",borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"#2E4A6A",marginBottom:12}}>
          Paycheck Settings
        </div>
        <div style={{display:"flex",gap:10,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"#4A6280",marginBottom:4}}>Net Pay</div>
            <input className="text-input" style={{padding:"8px 12px",fontSize:14}}
              placeholder="e.g. 3200" type="number" inputMode="decimal"
              value={localNetPay}
              onChange={e=>setLocalNetPay(e.target.value)}
              onBlur={()=>onSaveBillsOverride({netPay:localNetPay,frequency:localFreq})}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"#4A6280",marginBottom:4}}>Frequency</div>
            <select className="form-select" style={{padding:"8px 12px",fontSize:13}}
              value={localFreq}
              onChange={e=>{setLocalFreq(e.target.value);onSaveBillsOverride({netPay:localNetPay,frequency:e.target.value});}}>
              {PAY_FREQS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        </div>
        <div style={{fontSize:11,color:"#2E4A6A"}}>
          Float × {floatMult} set in Accounts · Pulls from Planner by default
        </div>
      </div>

      {sim && <>

        {/* ── Trough warning card ── */}
        <div style={{
          background: sim.troughLowest < 0 ? "#FF6B6B12" : "#111E33",
          border:`1px solid ${sim.troughLowest < 0 ? "#FF6B6B40" : "#1A2E4A"}`,
          borderRadius:14, padding:16, marginBottom:16
        }}>
          <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"#2E4A6A",marginBottom:10}}>
            Trough Forecast
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontSize:13,color:"#C8D8E8",marginBottom:4}}>
                Lowest expected balance
              </div>
              <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:28,fontWeight:700,
                color:sim.troughLowest>=sim.warnThresh?"#00D4AA":sim.troughLowest>=0?"#F5C842":"#FF6B6B",
                lineHeight:1}}>
                {fmt(sim.troughLowest)}
              </div>
              <div style={{fontSize:11,color:"#4A6280",marginTop:4}}>
                Around {sim.troughDate} · day {sim.lowestDay} of simulation
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11,color:"#4A6280",marginBottom:4}}>Trough depth</div>
              <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:18,fontWeight:600,
                color: sim.troughExposure > totalBillsBal*0.5 ? "#FF6B6B" : "#F5C842"}}>
                −{fmt(sim.troughExposure)}
              </div>
              <div style={{fontSize:10,color:"#2E4A6A",marginTop:2}}>from current</div>
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
            <div style={{marginTop:12,padding:"8px 12px",background:"#00D4AA12",borderRadius:8,fontSize:12,color:"#00D4AA"}}>
              Your float fully covers the {sim.mult}× window. You have room for variable bills.
            </div>
          )}
        </div>

        {/* ── Scale bar ── */}
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:600,letterSpacing:"1.5px",textTransform:"uppercase",color:"#2E4A6A"}}>
              Bills Account · Now
            </span>
            <span style={{fontFamily:"'Space Grotesk',monospace",fontSize:22,fontWeight:700,color:sim.zoneColor}}>
              {fmt(totalBillsBal)}
            </span>
          </div>

          <div style={{position:"relative",height:32,borderRadius:16,overflow:"hidden",background:"#0D1929",marginBottom:6}}>
            {/* zone fills */}
            <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${warnPct}%`,background:"#FF6B6B18"}}/>
            <div style={{position:"absolute",left:`${warnPct}%`,top:0,bottom:0,width:`${safePct-warnPct}%`,background:"#F5C84212"}}/>
            <div style={{position:"absolute",left:`${safePct}%`,top:0,bottom:0,right:0,background:"#00D4AA0A"}}/>
            {/* zone lines */}
            <div style={{position:"absolute",left:`${warnPct}%`,top:0,bottom:0,width:2,background:"#F5C842",opacity:0.4}}/>
            <div style={{position:"absolute",left:`${safePct}%`,top:0,bottom:0,width:2,background:"#00D4AA",opacity:0.4}}/>
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
            <span style={{fontSize:10,color:"#00D4AA"}}>Covered ({sim.mult}×)</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:10,color:"#4A6280"}}>0</span>
            <span style={{fontSize:10,color:"#4A6280"}}>{fmt(sim.warnThresh)}</span>
            <span style={{fontSize:10,color:"#4A6280"}}>{fmt(sim.safeThresh)}</span>
          </div>
        </div>

        {/* ── Bills account balances ── */}
        {billsBanks.map(a=>(
          <div key={a.last4} style={{background:"#111E33",border:"1px solid #1A2E4A",borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:"#C8D8E8"}}>{a.label}</div>
              <div style={{fontSize:11,color:"#4A6280"}}>•••• {a.last4} · Float ×{a.floatMultiplier||1.5}</div>
            </div>
            <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:"#9B88FF"}}>
              {latestBalance(a.last4)!==null ? fmt(latestBalance(a.last4)) : "—"}
            </div>
          </div>
        ))}

        {/* ── Cycle timeline ── */}
        <div style={{fontSize:10,fontWeight:600,letterSpacing:"2px",textTransform:"uppercase",color:"#2E4A6A",margin:"20px 0 10px"}}>
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
            <div key={ci} style={{background:"#111E33",border:"1px solid #1A2E4A",borderRadius:14,padding:"14px 16px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#E8EEF6"}}>
                    {ci===0 ? "Now" : `Cycle ${ci+1}`} · {cycle.days[0].dateStr}–{cycle.days[cycle.days.length-1].dateStr}
                  </div>
                  {paycheckDay && (
                    <div style={{fontSize:11,color:"#00D4AA",marginTop:2}}>
                      +{fmt(sim.paycheckAmt)} paycheck on {paycheckDay.dateStr}
                    </div>
                  )}
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:"#4A6280"}}>Ends at</div>
                  <div style={{fontFamily:"'Space Grotesk',monospace",fontSize:16,fontWeight:600,color:cycleCol}}>{fmt(endBal)}</div>
                  <div style={{fontSize:10,color:"#2E4A6A",marginTop:1}}>low: {fmt(cycleTrough)}</div>
                </div>
              </div>
              {billDays.length > 0 && (
                <div style={{borderTop:"1px solid #1A2E4A",paddingTop:8}}>
                  {billDays.map((d,j)=>(
                    <div key={j} style={{display:"flex",justifyContent:"space-between",padding:"3px 0"}}>
                      <span style={{fontSize:12,color:"#4A6280"}}>{d.dateStr}</span>
                      <span style={{fontSize:12,color:"#F5A623"}}>−{fmt(d.billsDue)}</span>
                      <span style={{fontFamily:"'Space Grotesk',monospace",fontSize:12,
                        color:d.bal>=sim.warnThresh?"#C8D8E8":d.bal>=0?"#F5C842":"#FF6B6B"}}>{fmt(d.bal)}</span>
                    </div>
                  ))}
                </div>
              )}
              {billDays.length === 0 && (
                <div style={{fontSize:12,color:"#2E4A6A",borderTop:"1px solid #1A2E4A",paddingTop:8}}>No bills due this cycle</div>
              )}
            </div>
          );
        })}

        {billDueDays(bills) === 0 && (
          <div style={{fontSize:13,color:"#2E4A6A",textAlign:"center",padding:"16px 0"}}>
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
            <span style={{fontSize:13,color:"#4A6280"}}>of each month</span>
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
        <div style={{fontFamily:"'Space Grotesk',sans-serif", fontSize:16, fontWeight:700, color:"#E8EEF6"}}>
          {fmt(totalMonthly)}<span style={{fontSize:11,color:"#4A6280",fontWeight:400}}>/mo</span>
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
    
