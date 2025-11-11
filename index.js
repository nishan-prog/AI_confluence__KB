// Force Node to use OpenSSL legacy provider before any imports
process.env.NODE_OPTIONS = '--openssl-legacy-provider';

import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import fs from "fs";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Path to Google service account key
const KEYFILE_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Gmail API client setup with impersonation
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE_PATH,
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
});

async function getGmailClient() {
  const client = await auth.getClient();
  // Impersonate the support mailbox
  client.subject = "support@stoneandchalk.com.au";
  return google.gmail({ version: "v1", auth: client });
}

// Confluence API setup
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL;
const CONFLUENCE_API_KEY = process.env.CONFLUENCE_API_KEY;
const CONFLUENCE_USER = process.env.CONFLUENCE_USER;
const CONFLUENCE_SPACE = process.env.CONFLUENCE_SPACE;

// Track processed emails
let processedEmails = new Set();

// Poll Gmail for new internal emails every minute
const POLL_INTERVAL = 60 * 1000;

async function pollEmails() {
  try {
    const gmail = await getGmailClient();

    const res = await gmail.users.messages.list({
      userId: "support@stoneandchalk.com.au",
      q: 'subject:"Internal" is:unread',
      maxResults: 10,
    });

    if (!res.data.messages) return;

    for (const msg of res.data.messages) {
      if (processedEmails.has(msg.id)) continue;

      const fullMsg = await gmail.users.messages.get({
        userId: "support@stoneandchalk.com.au",
        id: msg.id,
        format: "full",
      });

      const subjectHeader = fullMsg.data.payload.headers.find(
        (h) => h.name === "Subject"
      )?.value;
      const fromHeader = fullMsg.data.payload.headers.find(
        (h) => h.name === "From"
      )?.value;

      const body = Buffer.from(
        fullMsg.data.payload.parts?.[0]?.body?.data || "",
        "base64"
      ).toString("utf8");

      // Placeholder for AI-generated summary (Gemini)
      const summary = `Summary placeholder for: ${subjectHeader}`;

      // Create draft Confluence page
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

      processedEmails.add(msg.id);
    }
  } catch (err) {
    console.error("Error polling emails:", err);
  }
}

setInterval(pollEmails, POLL_INTERVAL);

app.get("/", (req, res) => {
  res.send("AI KB Draft Bot Running");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
