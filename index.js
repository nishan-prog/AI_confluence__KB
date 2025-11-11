// index.js
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import axios from 'axios';
import { PredictionServiceClient } from '@google-cloud/aiplatform';

dotenv.config();

// Load state for processed emails
const stateFile = './state.json';
let state = {};
if (fs.existsSync(stateFile)) {
  state = JSON.parse(fs.readFileSync(stateFile));
}

// Environment variables
const {
  CONFLUENCE_BASE_URL,
  CONFLUENCE_EMAIL,
  CONFLUENCE_API_TOKEN,
  CONFLUENCE_SPACE,
  GMAIL_CLIENT_EMAIL,
  GMAIL_PRIVATE_KEY,
  GMAIL_PROJECT_ID,
  GMAIL_IMPERSONATED_USER
} = process.env;

// Setup Gmail via service account impersonation
const auth = new google.auth.JWT({
  email: GMAIL_CLIENT_EMAIL,
  key: GMAIL_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  subject: GMAIL_IMPERSONATED_USER
});
const gmail = google.gmail({ version: 'v1', auth });

// Setup Vertex AI / Gemini client
const vertexClient = new PredictionServiceClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Create Confluence draft helper
async function createConfluenceDraft(title, content) {
  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/`;
  const payload = {
    type: 'page',
    title,
    space: { key: CONFLUENCE_SPACE },
    body: { storage: { value: content, representation: 'storage' } },
    metadata: { labels: ['review-needed'] }
  };
  const authHeader = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');
  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/json'
    }
  });
  return resp.data;
}

// Fetch recent “Internal” emails
async function fetchInternalEmails() {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'subject:"Internal"',
    maxResults: 5
  });
  return res.data.messages || [];
}

async function getEmailDetails(emailId) {
  const res = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'full' });
  const headers = res.data.payload.headers || [];
  const from = headers.find(h => h.name === 'From')?.value || 'unknown';
  const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
  const date = headers.find(h => h.name === 'Date')?.value || '';
  let body = '';
  if (res.data.payload.parts) {
    const part = res.data.payload.parts.find(p => p.mimeType === 'text/plain');
    if (part && part.body?.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  } else if (res.data.payload.body?.data) {
    body = Buffer.from(res.data.payload.body.data, 'base64').toString('utf-8');
  }
  return { id: emailId, from, subject, date, body };
}

// Summarize via Vertex AI / Gemini
async function summarizeText(text) {
  const [response] = await vertexClient.predict({
    endpoint: `projects/${GMAIL_PROJECT_ID}/locations/us-central1/endpoints/<YOUR_ENDPOINT_ID>`,
    instances: [{ content: text }],
    parameters: {}
  });
  // The response structure may vary — adapt as needed
  return response.predictions?.[0]?.content || text;
}

// Main process
async function processEmails() {
  const emails = await fetchInternalEmails();
  for (const e of emails) {
    if (state[e.id]) continue;
    try {
      const ticket = await getEmailDetails(e.id);
      const summary = await summarizeText(ticket.body);
      const pageTitle = `KB Draft – ${ticket.subject}`;
      const contentHtml = `
        <p><b>Ticket ID:</b> ${ticket.id}</p>
        <p><b>From:</b> ${ticket.from}</p>
        <p><b>Date:</b> ${ticket.date}</p>
        <p><b>Summary:</b></p>
        <p>${summary}</p>`;
      await createConfluenceDraft(pageTitle, contentHtml);
      console.log(`Created draft for ${ticket.id}`);
      state[ticket.id] = true;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`Error processing ${e.id}`, err.response?.data || err.message);
    }
  }
}

// Run at startup and then every 5 minutes
processEmails();
setInterval(processEmails, 5 * 60 * 1000);

// Start simple server to keep alive
import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('AI KB Bot alive.'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
