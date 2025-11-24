// Force Node to use OpenSSL legacy provider before any imports
process.env.NODE_OPTIONS = '--openssl-legacy-provider';

import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Constants ----
const POLL_INTERVAL = 60 * 1000; // 1 min
let processedEmails = new Set();  // Track processed emails
let reviewQueue = [];             // Emails waiting for review
const STATE_FILE = "./state.json";
let state = {};

// ---- Load state.json ----
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    console.error("❌ Failed to parse state.json:", err.message);
    state = {};
  }
}

// ---- Save state helper ----
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- Load Google service account credentials ----
if (!process.env.GOOGLE_SERVICE_JSON) {
  console.error("❌ Missing GOOGLE_SERVICE_JSON environment variable");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_JSON);
} catch (err) {
  console.error("❌ Invalid JSON in GOOGLE_SERVICE_JSON:", err);
  process.exit(1);
}

// ---- Gmail API Auth ----
const auth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  subject: "support@stoneandchalk.com.au",
});

const gmail = google.gmail({ version: "v1", auth });

// ---- Confluence API setup ----
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_SITE;
const CONFLUENCE_API_KEY = process.env.CONFLUENCE_API_KEY;
const CONFLUENCE_USER = process.env.CONFLUENCE_USER;
const CONFLUENCE_SPACE = process.env.CONFLUENCE_SPACE;

// ---- Jira API setup ----
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ? process.env.JIRA_BASE_URL.replace(/\/$/, '') : null;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_USER = process.env.JIRA_USER;

if (!JIRA_BASE_URL) {
  console.error("❌ Missing JIRA_BASE_URL environment variable");
  process.exit(1);
}
if (!JIRA_API_TOKEN) {
  console.error("❌ Missing JIRA_API_TOKEN environment variable");
  process.exit(1);
}
if (!JIRA_USER) {
  console.error("❌ Missing JIRA_USER environment variable");
  process.exit(1);
}

// ---- Poll Jira Service Desk for recently resolved tickets ----
const SERVICE_DESK_ID = process.env.JIRA_SERVICE_DESK_ID; // e.g., "11"
const MAX_RESULTS = 20;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT; // e.g., "https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateMessage"

async function getGeminiSummary(ticket) {
  try {
    const promptText = `
Write a Confluence-ready summary for this resolved Jira ticket. 
Use clear, separate paragraphs for different sections so it is easy to read and copy-paste into a knowledge base page.

Ticket Key: ${ticket.key}
Title: ${ticket.summary}
Raised by: ${ticket.reporter}
Status: ${ticket.status}
Resolution date: ${ticket.resolutiondate}

Description:
${ticket.description}

Latest Comment:
${ticket.latestComment}

Resolution Notes:
${ticket.resolutionText}

Summarise clearly what was done to resolve the ticket, using bullet points or numbered steps if applicable.
Include headings for sections like "Issue", "Troubleshooting Steps", "Resolution", "Lessons Learned" where relevant.
`;

    const res = await axios.post(
      GEMINI_ENDPOINT,
      {
        contents: [
          { parts: [{ text: promptText }] }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": GEMINI_API_KEY
        }
      }
    );

    const candidate = res.data?.candidates?.[0];
    const summary = candidate?.content?.parts?.map(p => p.text).join("\n") || ticket.summary;
    return summary;

  } catch (err) {
    console.error("🚨 Error generating Gemini summary:", err.response?.data || err.message);
    return ticket.summary;
  }
}

async function pollJiraTickets() {
  try {
    console.log("🔍 Polling Jira Service Desk for resolved tickets...");

    const jql = `project = SC AND status = Resolved AND resolved >= -5d ORDER BY resolved DESC`;

    const res = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/search/jql`,
      {
        jql,
        maxResults: MAX_RESULTS,
        fields: [
          "summary",
          "status",
          "resolution",
          "resolutiondate",
          "assignee",
          "reporter",
          "description",
          "comment"
        ]
      },
      {
        auth: { username: JIRA_USER, password: JIRA_API_TOKEN },
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      }
    );

    const issues = res.data.issues || [];
    console.log(`📋 Fetched ${issues.length} resolved ticket(s) (via JQL v3).`);

    for (const issue of issues) {
      const fields = issue.fields;

      // ---- Extract description safely ----
      let description = "";
      try {
        if (fields?.description?.content) {
          description = fields.description.content
            .map(c => c?.content?.map(p => p.text).join(" "))
            .join("\n");
        } else if (typeof fields?.description === "string") {
          description = fields.description;
        }
      } catch {}
      if (!description) description = "No description provided.";

      // ---- Extract latest comment ----
      const commentsArray = fields?.comment?.comments || [];
      const latestComment =
        commentsArray.length > 0
          ? commentsArray[commentsArray.length - 1].body
          : "No comments provided.";

      // ---- Extract resolution details ----
      const resolutionText =
        fields?.resolution?.description ||
        fields?.resolution?.name ||
        "No resolution details provided.";

      // ---- Build structured ticket object for Gemini ----
      const ticketObject = {
        key: issue.key,
        summary: fields?.summary || "No title",
        reporter: fields?.reporter?.displayName || "Unknown",
        status: fields?.status?.name || "Unknown",
        resolutiondate: fields?.resolutiondate || "Unknown",
        description,
        latestComment,
        resolutionText
      };

      const assigneeEmail = fields?.assignee?.emailAddress || JIRA_USER;

      if (assigneeEmail && !processedEmails.has(issue.key)) {
        const body = await getGeminiSummary(ticketObject);

        // ---- Convert text to HTML paragraphs for email ----
        const summaryHTML = body
          .split("\n\n")
          .map(p => `<p>${p}</p>`)
          .join("\n");

        reviewQueue.push({
          subject: `[${issue.key}] ${ticketObject.summary}`,
          body
        });

        await sendReviewEmail(
          assigneeEmail,
          `[${issue.key}] ${ticketObject.summary}`,
          summaryHTML
        );

        console.log(`📝 Ticket added to review queue: [${issue.key}] ${ticketObject.summary}`);
        processedEmails.add(issue.key);
      }
    }

    state.lastPollTimestamp = Date.now();
    saveState();

  } catch (err) {
    console.error(
      "🚨 Error polling Jira Service Desk (JQL v3):",
      err.response?.data || err.message
    );
  }
}

// ---- Send review email ----
async function sendReviewEmail(assigneeEmail, subject, summaryHTML) {
  try {
    const rawMessage = [
      `From: support@stoneandchalk.com.au`,
      `To: ${assigneeEmail}`,
      `Subject: Review Required: ${subject}`,
      `Content-Type: text/html; charset=UTF-8`,
      "",
      `<p>Hi,</p>
      <p>A new internal email summary generated by Gemini is ready for review:</p>
      ${summaryHTML}
      <p>Approve this to post to Confluence.</p>`
    ].join("\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: "support@stoneandchalk.com.au",
      requestBody: { raw: encodedMessage },
    });

    console.log(`✉️ Review email sent to: ${assigneeEmail}`);
  } catch (err) {
    console.error("🚨 Failed to send review email:", err.response?.data || err.message);
  }
}


// ---- Post approved summaries to Confluence ----
async function postToConfluence() {
  if (reviewQueue.length === 0) {
    console.log("📭 No emails in review queue.");
    return;
  }

  for (const item of reviewQueue) {
    try {
      await axios.post(
        `${CONFLUENCE_BASE_URL}/rest/api/content/`,
        {
          type: "page",
          title: `KB Draft - ${item.subject}`,
          space: { key: CONFLUENCE_SPACE },
          body: { storage: { value: `<p>${item.body}</p>`, representation: "storage" } },
        },
        { auth: { username: CONFLUENCE_USER, password: CONFLUENCE_API_KEY }, headers: { "Content-Type": "application/json" } }
      );
      console.log(`✅ Confluence draft created for: ${item.subject}`);
    } catch (err) {
      console.error(`🚨 Failed to create Confluence page for: ${item.subject}`, err.response?.data || err.message);
    }
  }

  reviewQueue = [];
}

// ---- Intervals ----
setInterval(pollJiraTickets, POLL_INTERVAL);

// ---- Manual endpoint to post review queue ----
app.post("/review/post", async (req, res) => {
  await postToConfluence();
  res.send("✅ Review queue posted to Confluence.");
});

app.get("/", (req, res) => {
  res.send("🚀 AI KB Draft Bot Running and Polling Jira");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
