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

// ---- Gmail API Auth with impersonation ----
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
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_USER = process.env.JIRA_USER;

// ---- Load or initialize persistent state ----
let state = { processedEmails: [], reviewQueue: [] };
const STATE_FILE = "./state.json";
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    console.warn("⚠️ Failed to read state.json, starting fresh");
  }
}

// ---- Save state function ----
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- Poll Gmail for internal emails ----
async function pollEmails() {
  try {
    console.log("🔍 Checking Gmail for internal emails...");

    const res = await gmail.users.messages.list({
      userId: "support@stoneandchalk.com.au",
      q: 'subject:"Internal"',
      maxResults: 10,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      console.log("📭 No new emails found.");
      return;
    }

    for (const msg of res.data.messages) {
      if (state.processedEmails.includes(msg.id)) continue;

      const fullMsg = await gmail.users.messages.get({
        userId: "support@stoneandchalk.com.au",
        id: msg.id,
        format: "full",
      });

      const headers = fullMsg.data.payload.headers;
      const subjectHeader = headers.find((h) => h.name === "Subject")?.value || "No Subject";
      const fromHeader = headers.find((h) => h.name === "From")?.value || "Unknown Sender";

      const body = Buffer.from(
        fullMsg.data.payload.parts?.[0]?.body?.data || "",
        "base64"
      ).toString("utf8");

      console.log(`📩 New email detected: ${subjectHeader} from ${fromHeader}`);

      // Add to review queue
      state.reviewQueue.push({
        id: msg.id,
        subject: subjectHeader,
        summary: body, // Assuming Gemini writes the summary in the email body
        from: fromHeader,
        jiraTicket: extractJiraTicket(subjectHeader) // helper function to extract ticket
      });
      state.processedEmails.push(msg.id);

      console.log(`📝 Email added to review queue: ${subjectHeader}`);
    }

    saveState();
  } catch (err) {
    console.error("🚨 Error polling emails:", err.response?.data || err.message);
  }
}

// ---- Helper to extract Jira ticket from subject ----
function extractJiraTicket(subject) {
  const match = subject.match(/[A-Z]+-\d+/);
  return match ? match[0] : null;
}

// ---- Check Jira ticket resolved & assignee ----
async function getJiraTicketInfo(ticketId) {
  if (!ticketId) return null;
  try {
    const res = await axios.get(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`,
        Accept: "application/json",
      },
    });
    const issue = res.data;
    return {
      assignee: issue.fields.assignee?.emailAddress,
      resolved: issue.fields.status?.name === "Done",
    };
  } catch (err) {
    console.error(`🚨 Failed to fetch Jira ticket info for ${ticketId}`, err.response?.data || err.message);
    return null;
  }
}

// ---- Send review email ----
async function sendReviewEmail(toEmail, subject, summary) {
  const rawMessage = [
    `From: support@stoneandchalk.com.au`,
    `To: ${toEmail}`,
    `Subject: Review KB Draft - ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    `Please review the AI-generated summary and approve to post to Confluence:\n\n${summary}`,
  ].join("\n");

  const encodedMessage = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "support@stoneandchalk.com.au",
    requestBody: { raw: encodedMessage },
  });
}

// ---- Process review queue ----
async function processReviewQueue() {
  for (const item of state.reviewQueue) {
    const jiraInfo = await getJiraTicketInfo(item.jiraTicket);
    if (!jiraInfo) continue;

    if (jiraInfo.resolved && jiraInfo.assignee) {
      // Send email to assignee for review
      await sendReviewEmail(jiraInfo.assignee, item.subject, item.summary);
      console.log(`✉️ Review email sent to ${jiraInfo.assignee} for ${item.subject}`);
    }
  }
}

// ---- Post to Confluence manually after approval ----
async function postToConfluence(subject, summary) {
  try {
    await axios.post(
      `${CONFLUENCE_BASE_URL}/rest/api/content/`,
      {
        type: "page",
        title: `KB Draft - ${subject}`,
        space: { key: CONFLUENCE_SPACE },
        body: {
          storage: {
            value: `<p>${summary}</p>`,
            representation: "storage",
          },
        },
      },
      {
        auth: {
          username: CONFLUENCE_USER,
          password: CONFLUENCE_API_KEY,
        },
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`✅ Confluence draft created for: ${subject}`);
  } catch (err) {
    console.error(`🚨 Failed to create Confluence page for: ${subject}`, err.response?.data || err.message);
  }
}

// ---- Poll Gmail every minute ----
setInterval(pollEmails, POLL_INTERVAL);

// ---- Review queue processing every 2 minutes ----
setInterval(processReviewQueue, 2 * 60 * 1000);

// ---- Manual endpoint to post after review ----
app.post("/review/post", async (req, res) => {
  const { subject, summary } = req.body;
  await postToConfluence(subject, summary);

  // Remove from review queue
  state.reviewQueue = state.reviewQueue.filter((i) => i.subject !== subject);
  saveState();

  res.send(`✅ Posted ${subject} to Confluence.`);
});

app.get("/", (req, res) => {
  res.send("🚀 AI KB Draft Bot Running and Polling Gmail");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
