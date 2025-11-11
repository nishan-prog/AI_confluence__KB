// index.js
import fs from 'fs';
import { google } from 'googleapis';
import axios from 'axios';
import { TextServiceClient } from '@google-cloud/ai';

let state = {};
const stateFile = './state.json';
if (fs.existsSync(stateFile)) {
  state = JSON.parse(fs.readFileSync(stateFile));
}

const {
  CONFLUENCE_SITE,
  CONFLUENCE_USER,
  CONFLUENCE_API_TOKEN,
  CONFLUENCE_SPACE,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN
} = process.env;

const oAuth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
const geminiClient = new TextServiceClient();

async function fetchEmails() {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread subject:Internal',
    maxResults: 5
  });
  return res.data.messages || [];
}

async function getEmail(id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const headers = res.data.payload.headers;
  const from = headers.find(h => h.name === 'From')?.value || 'unknown';
  const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
  const date = headers.find(h => h.name === 'Date')?.value || '';
  let body = '';
  if (res.data.payload.parts) {
    const part = res.data.payload.parts.find(p => p.mimeType === 'text/plain');
    if (part) body = Buffer.from(part.body.data, 'base64').toString('utf-8');
  } else {
    body = Buffer.from(res.data.payload.body.data || '', 'base64').toString('utf-8');
  }
  return { id, from, subject, date, body };
}

async function generateSummary(text) {
  const response = await geminiClient.generateText({
    model: 'models/text-bison-001',
    input: `Summarize this IT support request concisely:\n\n${text}`
  });
  return response[0].content;
}

async function postDraft(ticket) {
  const summary = await generateSummary(ticket.body);
  const pageContent = `
    <b>Ticket ID:</b> ${ticket.id}<br>
    <b>From:</b> ${ticket.from}<br>
    <b>Date:</b> ${ticket.date}<br>
    <b>Summary:</b><br>${summary}
  `;
  const pageData = {
    type: 'page',
    title: `KB Draft - ${ticket.subject}`,
    space: { key: CONFLUENCE_SPACE },
    body: { storage: { value: pageContent, representation: 'storage' } },
    metadata: { labels: ['review-needed'] }
  };
  await axios.post(`${CONFLUENCE_SITE}/rest/api/content/`, pageData, {
    auth: { username: CONFLUENCE_USER, password: CONFLUENCE_API_TOKEN },
    headers: { 'Content-Type': 'application/json' }
  });
}

async function processTickets() {
  const emails = await fetchEmails();
  for (const e of emails) {
    if (state[e.id]) continue;
    const ticket = await getEmail(e.id);
    ticket.id = e.id;
    try {
      await postDraft(ticket);
      console.log(`Draft created for email ${ticket.id}`);
      state[ticket.id] = true;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      await gmail.users.messages.modify({ userId: 'me', id: e.id, requestBody: { removeLabelIds: ['UNREAD'] } });
    } catch (err) {
      console.error(`Failed for email ${ticket.id}:`, err.response?.data || err.message);
    }
  }
}

setInterval(processTickets, 2 * 60 * 1000);
processTickets();
