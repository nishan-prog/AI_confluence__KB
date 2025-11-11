// Force Node to use OpenSSL legacy provider before any imports
process.env.NODE_OPTIONS = '--openssl-legacy-provider';

import express from 'express';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Path to your service account JSON
const KEY_FILE_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS; 

// Initialize Google auth client
const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE_PATH,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly']
});

// Example route to test server
app.get('/', (req, res) => {
  res.send('AI Confluence KB server is running!');
});

// Example route for Gmail or Gemini processing
app.post('/process-email', async (req, res) => {
  try {
    const client = await auth.getClient();
    const gmail = google.gmail({ version: 'v1', auth: client });

    // Placeholder: get latest messages, process, summarize, etc.
    // Example: list 5 latest messages
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5
    });

    res.json({ messages: response.data.messages || [] });
  } catch (err) {
    console.error('Error processing emails:', err);
    res.status(500).send('Error processing emails');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
