// index.js
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Google Vertex AI setup ----
const vertexClient = new PredictionServiceClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

// ---- Gmail setup ----
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// ---- Confluence API helper ----
async function createConfluenceDraft(title, content) {
  const url = `${process.env.CONFLUENCE_BASE_URL}/rest/api/content/`;
  const payload = {
    type: "page",
    title: title,
    space: { key: process.env.CONFLUENCE_SPACE },
    body: { storage: { value: content, representation: "storage" } },
    status: "draft"
  };

  const auth = Buffer.from(`${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_KEY}`).toString('base64');

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

// ---- Fetch emails and summarize ----
async function fetchAndSummarizeEmails() {
  // List latest emails with "Internal" in subject
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'subject:Internal',
    maxResults: 5
  });

  if (!res.data.messages) return;

  for (const msg of res.data.messages) {
    const messageDetail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
    const body = messageDetail.data.snippet;

    // ---- Use Vertex AI to summarize ----
    const [response] = await vertexClient.predict({
      endpoint: 'projects/YOUR_PROJECT/locations/us-central1/endpoints/YOUR_ENDPOINT_ID', // replace with your Gemini endpoint
      instances: [{ content: body }],
      parameters: {}
    });

    const summary = response.predictions[0]?.summary || body;

    // Create draft Confluence page
    const draft = await createConfluenceDraft(`Internal Ticket Summary: ${msg.id}`, summary);
    console.log('Draft created:', draft.id);
  }
}

// ---- Express endpoint (trigger fetch manually) ----
app.get('/run', async (req, res) => {
  try {
    await fetchAndSummarizeEmails();
    res.send('Emails fetched and draft KB pages created.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error processing emails.');
  }
});

app.listen(PORT, () => {
  console.log(`AI KB bot running on port ${PORT}`);
});
