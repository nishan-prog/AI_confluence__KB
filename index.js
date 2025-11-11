// Force Node to use OpenSSL legacy provider before any imports
process.env.NODE_OPTIONS = '--openssl-legacy-provider';

import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import axios from "axios";

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

// ---- Gmail API Auth with impersonation (Domain-wide Delegation) ----
const auth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  subject: "support@stoneandchalk.com.au", // Impersonate mailbox
});

const gmail = google.gmail({ version: "v1", auth });

// ---- Confluence API setup ----
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL;
const CONFLUENCE_API_KEY = process.env.CONFLUENCE_API_KEY;
const CONFLUENCE_USER = process.env.CONFLUENCE_USER;
const CONFLUENCE_SPACE = process.env.CONFLUENCE_SPACE;

// ---- Track processed emails ----
let processedEmails = new Set();
const POLL_INTERVAL = 60 * 1000;

async function pollEmails() {
  try {
    console.log("🔍 Checking Gmail for internal emails...");

    // Fetch emails regardless of read/unread
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
      if (processedEmails.has(msg.id)) continue;

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

      console.log(`📩 New email: ${subjectHeader} from ${fromHeader}`);

      // Placeholder for AI-generated summary (Gemini)
      const summary = `Summary placeholder for: ${subjectHeader}`;

      // ---- Create draft Confluence page ----
      try {
        await axios.post(
          `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/`,
          {
            type: "page",
            title: `KB Draft - ${subjectHeader}`,
            space: { key: CONFLUENCE_SPACE },
            body: {
              storage: {
                value: `<p>${summary}</p>`,
                representation: "storage",
              },
            },
          },
          {
            auth: { username: CONFLUENCE_USER, password: CONFLUENCE_API_KEY },
            headers: { "Content-Type": "application/json" },
          }
        );
        console.log(`✅ Confluence draft created for: ${subjectHeader}`);
      } catch (err) {
        console.error(`🚨 Failed to create Confluence page for: ${subjectHeader}`, err.response?.data || err.message);
      }

      processedEmails.add(msg.id);
    }
  } catch (err) {
    console.error("🚨 Error polling emails:", err.response?.data || err.message);
  }
}

setInterval(pollEmails, POLL_INTERVAL);

app.get("/", (req, res) => {
  res.send("🚀 AI KB Draft Bot Running and Polling Gmail");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
