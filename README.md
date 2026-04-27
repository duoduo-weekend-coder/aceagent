# AceAgent — Automated Tennis Court Booking AI

AceAgent calls a tennis club on your behalf, navigates hold music and IVR menus, and books a court — all via voice AI powered by Gemini Live and Twilio.

## How it works

1. You configure your booking preferences (preferred days, court type, duration)
2. AceAgent calls the club's phone number via Twilio
3. Gemini Live handles the conversation — navigating IVR menus, waiting on hold, and talking to the receptionist
4. When a booking is confirmed, you receive an email with the details and full call transcript

## Prerequisites

- [Twilio account](https://twilio.com) with a phone number (~$1/month)
- [Gemini API key](https://aistudio.google.com/apikey) (free tier works)
- Gmail App Password for email confirmations (optional)

## Quickstart — deploy to Railway (no local setup needed)

1. Fork this repo on GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select your fork
4. In **Variables**, add:
   ```
   GEMINI_API_KEY=...
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_PHONE_NUMBER=+1...
   EMAIL_USER=you@gmail.com      # optional
   EMAIL_PASS=xxxx xxxx xxxx xxxx  # optional — Gmail App Password
   ```
5. Railway builds and deploys automatically. Your app URL is your Twilio webhook base URL — no ngrok needed.

## Local development

```bash
# 1. Clone and install
git clone https://github.com/your-username/aceagent
cd aceagent
npm install

# 2. Copy and fill in credentials
cp .env.example .env

# 3. Terminal 1: backend
npm start

# 4. Terminal 2: frontend (hot-reload)
npm run dev

# 5. Terminal 3: expose backend to Twilio (real calls only)
ngrok http 8080
```

Open **http://localhost:5173** in your browser.

- **Browser Simulation** mode: no Twilio or ngrok needed — you play the receptionist
- **Real Phone Call** mode: requires ngrok running and the ngrok URL set in the Backend URL field

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Gemini API key from AI Studio |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Your Twilio number in E.164 format |
| `EMAIL_USER` | No | Gmail address for sending call summaries |
| `EMAIL_PASS` | No | Gmail App Password (not your login password) |
| `BASE_URL` | No | Override the public URL for Twilio webhooks. Auto-detected otherwise. |
| `PORT` | No | Server port (default: 8080) |

## Twilio trial accounts

Trial accounts can only call verified numbers. Add your test number at:
**Twilio Console → Phone Numbers → Verified Caller IDs**

## Stack

- **Backend**: Node.js + Express + WebSocket
- **Voice AI**: Google Gemini Live (`gemini-2.5-flash-native-audio-preview`)
- **Telephony**: Twilio Voice + Media Streams
- **Frontend**: React + TypeScript + Vite + Tailwind CSS
