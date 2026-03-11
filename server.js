/**
 * Advait Assignment Tracker — Replit Server
 * ==========================================
 * - Scrapes Aeries with Puppeteer (real Chrome)
 * - Serves the React dashboard as static HTML
 * - All in one file, no build step needed
 */

const express   = require("express");
const puppeteer = require("puppeteer");
const cors      = require("cors");
const path      = require("path");

const app  = express();
app.use(cors());
app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://fremontusd.aeries.net";

// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = { assignments: [], lastUpdated: null };

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrapeAeries() {
  console.log("🚀 Launching browser...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    // ── LOGIN ────────────────────────────────────────────────────────────────
    console.log("📋 Going to login page...");
    await page.goto(`${BASE}/student/LoginParent.aspx`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Fill username
    await page.waitForSelector("#portalAccountUsername", { timeout: 10000 });
    await page.type("#portalAccountUsername", process.env.AERIES_USER || "");
    console.log("✅ Username entered");

    // Fill password
    await page.waitForSelector("#portalAccountPassword", { timeout: 10000 });
    await page.type("#portalAccountPassword", process.env.AERIES_PASS || "");
    console.log("✅ Password entered");

    // Set cookie flag via JS (Aeries checks this)
    await page.evaluate(() => {
      const el = document.getElementById("checkCookiesEnabled");
      if (el) el.value = "true";
    });

    // Submit
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.evaluate(() => {
        // Click the login button
        const btn = document.querySelector("button[type=submit], input[type=submit]");
        if (btn) btn.click();
      }),
    ]);

    console.log("✅ Logged in. URL:", page.url());

    if (page.url().includes("Login")) {
      throw new Error("Login failed — still on login page. Check AERIES_USER and AERIES_PASS.");
    }

    // ── GRADEBOOK ────────────────────────────────────────────────────────────
    console.log("📚 Going to gradebook...");
    await page.goto(`${BASE}/student/Gradebook.aspx`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // ── TRY JSON API ─────────────────────────────────────────────────────────
    console.log("🔍 Trying JSON API endpoints...");
    const apiResult = await page.evaluate(async () => {
      const endpoints = [
        "/student/api/gradebook/summary",
        "/student/api/Gradebook/summary",
        "/api/Gradebook/GetGradebookSummaryData",
        "/student/api/gradebook",
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, {
            credentials: "include",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "Accept": "application/json",
            },
          });
          if (r.ok) {
            const ct = r.headers.get("content-type") || "";
            if (ct.includes("json")) {
              const data = await r.json();
              return { ok: true, data, ep };
            }
          }
        } catch {}
      }
      return { ok: false };
    });

    if (apiResult.ok) {
      console.log("✅ Got JSON from", apiResult.ep);
      await browser.close();
      return parseJsonData(apiResult.data);
    }

    // ── FALLBACK: DOM SCRAPE ──────────────────────────────────────────────────
    console.log("⚠️  No JSON API, scraping DOM...");
    await page.waitForSelector(
      ".GradebookClass, [data-classid], tbody tr",
      { timeout: 15000 }
    ).catch(() => {});

    const assignments = await page.evaluate(() => {
      const results = [];
      let currentSubject = "Unknown";
      let currentTeacher = "";

      const sections = document.querySelectorAll(
        ".GradebookClass, .gradebook-class, [data-classid]"
      );

      if (sections.length > 0) {
        sections.forEach((section) => {
          const subjectEl = section.querySelector(
            ".ClassName, .CourseName, h2, h3, h4, .panel-title"
          );
          const teacherEl = section.querySelector(".TeacherName, .teacherName");
          currentSubject = subjectEl?.innerText?.trim() || "Unknown";
          currentTeacher = teacherEl?.innerText?.trim() || "";

          section.querySelectorAll("tbody tr").forEach((row) => {
            const cells = [...row.querySelectorAll("td")];
            if (cells.length < 2) return;
            const title    = cells[0]?.innerText?.trim();
            const dueDate  = cells[1]?.innerText?.trim();
            const score    = cells[2]?.innerText?.trim() || "";
            const maxScore = cells[3]?.innerText?.trim() || "";
            if (!title || title.length < 2) return;
            let status = "upcoming";
            if (score === "M" || score.toLowerCase().includes("miss")) status = "missed";
            else if (score && score !== "-") status = "submitted";
            results.push({ subject: currentSubject, teacher: currentTeacher, title, dueDate, score, maxScore, status });
          });
        });
      } else {
        document.querySelectorAll("tbody tr").forEach((row) => {
          const header = row.querySelector("th");
          if (header) { currentSubject = header.innerText?.trim(); return; }
          const cells = [...row.querySelectorAll("td")];
          if (cells.length < 2) return;
          const title    = cells[0]?.innerText?.trim();
          const dueDate  = cells[1]?.innerText?.trim();
          const score    = cells[2]?.innerText?.trim() || "";
          const maxScore = cells[3]?.innerText?.trim() || "";
          if (!title || title.length < 2) return;
          let status = "upcoming";
          if (score === "M" || score.toLowerCase().includes("miss")) status = "missed";
          else if (score && score !== "-") status = "submitted";
          results.push({ subject: currentSubject, teacher: currentTeacher, title, dueDate, score, maxScore, status });
        });
      }
      return results;
    });

    await browser.close();
    console.log(`✅ Scraped ${assignments.length} assignments`);
    return assignments.map(enrichAssignment);

  } catch (err) {
    await browser.close();
    throw err;
  }
}

function getLetterGrade(pct) {
  if (pct >= 97) return "A+";
  if (pct >= 93) return "A";
  if (pct >= 90) return "A-";
  if (pct >= 87) return "B+";
  if (pct >= 83) return "B";
  if (pct >= 80) return "B-";
  if (pct >= 77) return "C+";
  if (pct >= 73) return "C";
  if (pct >= 70) return "C-";
  if (pct >= 60) return "D";
  return "F";
}

function enrichAssignment(a) {
  const s = parseFloat(a.score);
  const m = parseFloat(a.maxScore);
  const pct = (!isNaN(s) && !isNaN(m) && m > 0) ? (s / m) * 100 : null;
  return {
    ...a,
    id: Math.random().toString(36).slice(2),
    grade: (a.score && a.maxScore) ? `${a.score}/${a.maxScore}` : null,
    gradeLetter: pct !== null ? getLetterGrade(pct) : null,
    points: a.maxScore || null,
  };
}

function parseJsonData(data) {
  const assignments = [];
  const classes = data?.Classes || data?.Gradebook || data?.courses
               || data?.data?.Classes || (Array.isArray(data) ? data : []);

  classes.forEach((cls) => {
    const subject = cls.CourseName || cls.ClassName || cls.name || "Unknown";
    const teacher = cls.TeacherName || cls.teacher || "";
    const items   = cls.GradebookItems || cls.Assignments
                 || cls.assignments || cls.items || [];

    items.forEach((item) => {
      const score    = String(item.Score    ?? item.score    ?? "");
      const maxScore = String(item.MaxScore || item.PossiblePoints || "");
      const dueDate  = item.DueDate  || item.dueDate  || item.Date || "";

      let status = "upcoming";
      if (item.Missing || score === "M") status = "missed";
      else if (score && score !== "" && score !== "null") status = "submitted";
      if (status === "upcoming" && dueDate && new Date(dueDate) < new Date()) status = "missed";

      const s = parseFloat(score), m = parseFloat(maxScore);
      const pct = (!isNaN(s) && !isNaN(m) && m > 0) ? (s / m) * 100 : null;

      assignments.push({
        id:          item.GradebookID || Math.random().toString(36).slice(2),
        subject,
        teacher,
        title:       item.Description || item.Title || item.AssignmentName || "Assignment",
        description: item.Notes || item.description || "",
        dueDate,
        dueTime:     item.DueTime || "",
        score,
        maxScore,
        points:      maxScore || null,
        grade:       (score && maxScore) ? `${score}/${maxScore}` : null,
        gradeLetter: pct !== null ? getLetterGrade(pct) : null,
        status,
      });
    });
  });

  return assignments;
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get("/api/assignments", async (req, res) => {
  try {
    const assignments = await scrapeAeries();
    cache = { assignments, lastUpdated: new Date().toISOString() };
    res.json({ success: true, assignments, lastUpdated: cache.lastUpdated });
  } catch (err) {
    console.error("❌ Scrape error:", err.message);
    if (cache.assignments.length > 0) {
      res.json({ success: true, ...cache, fromCache: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, lastUpdated: cache.lastUpdated });
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Advait Tracker running at http://0.0.0.0:${PORT}`);
  console.log(`   AERIES_USER: ${process.env.AERIES_USER ? "✅ set" : "❌ NOT SET"}`);
  console.log(`   AERIES_PASS: ${process.env.AERIES_PASS ? "✅ set" : "❌ NOT SET"}\n`);
});
