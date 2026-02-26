# Work Tracker

Next.js + Firebase work-hour tracker with:

- One-tap clock in/out
- Break tracker (pause/resume)
- Manual log entry
- Project and task categorization
- Earnings calculator (hourly rate + currency)
- 7-day chart report (Recharts)
- Idle detection prompt + browser notification
- Optional geolocation tags
- CSV and PDF export

## 1. Install and run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## 2. Firebase setup

Copy `.env.example` to `.env.local` and fill in values from your Firebase web app config:

```bash
cp .env.example .env.local
```

Required:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

Also used:

- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` (optional)

## 3. Firebase services

- Enable **Authentication** with **Google** provider.
- Create **Cloud Firestore** database.

## Firestore schema

### `users/{uid}`

- `uid: string`
- `email: string`
- `displayName: string`
- `hourlyRate: number`
- `settings: { currency, darkMode, idleMinutes }`

### `projects/{projectId}`

- `userId: string`
- `name: string`
- `color: string`

### `timeLogs/{logId}`

- `userId: string`
- `projectId: string | null`
- `projectName: string`
- `taskName: string`
- `startTime: timestamp`
- `endTime: timestamp | null`
- `totalMinutes: number`
- `breakMinutes: number`
- `breaks: [{ startTime, endTime, durationMinutes }]`
- `note: string`
- `status: "completed" | "active" | "on-break"`
- `location: { latitude, longitude, accuracy, capturedAt } | null`
- `source: "timer" | "manual"`

## Notes

- App keeps timer ticking locally (`useEffect`) and only writes meaningful state changes to Firestore.
- If Firebase env vars are missing, the UI shows setup instructions instead of crashing.
