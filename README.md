# Eliza Scheduler

A standalone Google Calendar scheduler service that can be run independently of the main Eliza project.

## Features

- Schedule Google Calendar events via REST API
- Natural language date/time parsing
- Conflict detection and duplicate prevention
- Google Meet integration
- Timezone support
- Idempotency support

## Setup

1. Install dependencies:
   ```bash
   npm install
   # or
   pnpm install
   ```

2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

3. Configure your Google Calendar API credentials in `.env`:
   - `GOOGLE_CLIENT_ID`: Your Google OAuth2 client ID
   - `GOOGLE_CLIENT_SECRET`: Your Google OAuth2 client secret
   - `GOOGLE_REFRESH_TOKEN`: Your Google OAuth2 refresh token
   - `GOOGLE_CALENDAR_ID`: Calendar ID (default: "primary")
   - `PORT`: Server port (default: 4005)
   - `TZ`: Timezone (default: "America/New_York")

## Running

### Development
```bash
npm run dev
# or
pnpm dev
```

### Production
```bash
npm run build
npm start
# or
pnpm build
pnpm start
```

## API Endpoints

### Health Check
- `GET /health` - Returns server status and configuration

### Schedule Event
- `POST /schedule` - Schedule a new calendar event

#### Request Body:
```json
{
  "email": "user@example.com",
  "label": "Thursday 5 pm",  // Natural language time (optional)
  "startIso": "2024-01-15T17:00:00",  // ISO datetime (optional)
  "durationMin": 60,  // Duration in minutes (default: 60)
  "tz": "America/New_York",  // Timezone (optional)
  "createMeet": true,  // Create Google Meet link (default: true)
  "roomId": "room123",  // Room identifier (optional)
  "agentId": "agent456",  // Agent identifier (optional)
  "externalKey": "unique-key",  // External idempotency key (optional)
  "summary": "Grand Villa Tour",  // Event title (optional)
  "location": "Grand Villa of Clearwater",  // Event location (optional)
  "description": "Thank you for scheduling..."  // Event description (optional)
}
```

#### Response:
```json
{
  "ok": true,
  "eventId": "google_event_id",
  "htmlLink": "https://calendar.google.com/event?eid=...",
  "whenText": "Thursday at 5:00 PM",
  "startIso": "2024-01-15T17:00:00.000-05:00"
}
```

## Error Responses

- `400` - Invalid request data
- `409` - Time conflict or duplicate event
- `500` - Server error

## Dependencies

- **fastify**: Web framework
- **@fastify/cors**: CORS support
- **zod**: Schema validation
- **googleapis**: Google Calendar API client
- **luxon**: Date/time manipulation
- **chrono-node**: Natural language date parsing
- **uuid**: UUID generation
- **dotenv**: Environment variable loading
