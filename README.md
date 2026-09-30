# Healthcare Digital Twin Architecture

This document outlines the architectural foundation for a Healthcare Digital Twin dashboard designed for predictive monitoring (focusing on sudden glucose spikes). The stack utilizes **Next.js (App Router)**, **TypeScript**, **Tailwind CSS**, **Shadcn UI**, and **Prisma ORM**.

---

## 1. Project Directory Structure

A senior-level directory structure prioritizing modularity, separation of concerns, and scalability for a large Next.js application.

```text
src/
├── app/                           # Next.js App Router (Routing & Layouts)
│   ├── (auth)/                    # Route group for authentication
│   ├── (dashboard)/               # Route group for main app layout
│   │   ├── patients/              # Patient listing & management
│   │   │   ├── page.tsx           
│   │   │   └── [id]/              # Digital Twin View (Dynamic Route)
│   │   │       ├── page.tsx       
│   │   │       └── loading.tsx    
│   │   ├── alerts/                # Global alerts center
│   │   ├── layout.tsx             # Shared dashboard layout (Sidebar/Header)
│   │   └── page.tsx               # Main doctor overview dashboard
│   ├── api/                       # Next.js API Routes (Route Handlers)
│   │   ├── webhooks/              # Ingestion endpoints for IoT CGM sensors
│   │   └── trpc/                  # (Optional) tRPC endpoints for type-safe APIs
│   ├── layout.tsx                 # Root layout (Providers, Fonts, Metadata)
│   └── globals.css                # Tailwind directives & global styles
├── components/                    # React Components
│   ├── ui/                        # Shadcn UI primitives (Button, Card, Dialog, etc.)
│   ├── dashboard/                 # Domain-specific dashboard components
│   ├── digital-twin/              # Complex visualizations (Charts, 3D models)
│   └── shared/                    # Reusable components (Nav, ErrorBoundaries)
├── lib/                           # Core utilities and configuration
│   ├── prisma.ts                  # Prisma client singleton (prevents connection exhaustion)
│   ├── utils.ts                   # Tailwind class merge utility (`cn`)
│   └── ai/                        # Client-side AI/Prediction logic or ML API wrappers
├── hooks/                         # Custom React Hooks
│   ├── useRealtimeTelemetry.ts    # WebSocket/SSE hook for live CGM streams
│   └── usePatientData.ts          # SWR/React Query hooks for caching
├── types/                         # Global TypeScript interfaces & types
├── server/                        # Server-side logic
│   ├── actions/                   # Next.js Server Actions (Mutations)
│   └── services/                  # Business logic (e.g., Prediction analysis)
└── prisma/                        # Database ORM
    ├── schema.prisma              # Database schema definitions
    ├── seed.ts                    # Seeding script for mock digital twin data
    └── migrations/                # Database migration history
```

---

## 2. Prisma Database Schema

The database schema is designed to handle both **static/slow-changing data** (Demographics, EHR) and **high-velocity dynamic data** (Sensor Logs, AI Predictions, Alerts). We use indexing on time-series queries to optimize performance.

```prisma
// prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// ---------------------------------------------------------
// Core Domain Models
// ---------------------------------------------------------

model Doctor {
  id        String    @id @default(uuid())
  email     String    @unique
  name      String
  specialty String?
  
  patients  Patient[] // One-to-many relationship with patients
  
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Patient {
  id              String         @id @default(uuid())
  mrn             String         @unique // Medical Record Number
  firstName       String
  lastName        String
  dateOfBirth     DateTime
  gender          String
  
  doctorId        String
  doctor          Doctor         @relation(fields: [doctorId], references: [id])
  
  // Relations
  ehrData         EHRRecord?
  sensorLogs      SensorLog[]
  predictions     Prediction[]
  alerts          Alert[]

  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

// ---------------------------------------------------------
// Static / Historical Medical Data
// ---------------------------------------------------------

model EHRRecord {
  id              String   @id @default(uuid())
  patientId       String   @unique
  patient         Patient  @relation(fields: [patientId], references: [id], onDelete: Cascade)
  
  bloodType       String?
  heightCm        Float?
  weightKg        Float?
  
  // Storing complex/nested medical structures as JSONB for flexibility
  medicalHistory  Json?    // e.g., ["Type 2 Diabetes", "Hypertension"]
  medications     Json?    // e.g., [{ name: "Metformin", dosage: "500mg" }]
  allergies       Json?    
  
  updatedAt       DateTime @updatedAt
}

// ---------------------------------------------------------
// High-Velocity / Dynamic Time-Series Data
// ---------------------------------------------------------

model SensorLog {
  id            String     @id @default(uuid())
  patientId     String
  patient       Patient    @relation(fields: [patientId], references: [id], onDelete: Cascade)
  
  timestamp     DateTime   @default(now())
  
  sensorType    SensorType // e.g., CGM
  value         Float      // e.g., 145.5
  unit          String     // e.g., "mg/dL"
  
  // Compound index for fast time-series queries per patient
  @@index([patientId, timestamp(sort: Desc)])
}

enum SensorType {
  CGM             // Continuous Glucose Monitor
  HEART_RATE
  BLOOD_PRESSURE
  SPO2
}

// ---------------------------------------------------------
// Predictive & Intelligence Models
// ---------------------------------------------------------

model Prediction {
  id            String   @id @default(uuid())
  patientId     String
  patient       Patient  @relation(fields: [patientId], references: [id], onDelete: Cascade)
  
  predictedAt   DateTime @default(now()) // When the AI made the prediction
  targetTime    DateTime                 // When the event is forecasted to occur
  
  eventType     String   // e.g., "SUDDEN_GLUCOSE_SPIKE", "HYPOGLYCEMIA"
  probability   Float    // Confidence score (0.0 to 1.0)
  severity      Severity
  context       Json?    // Explainable AI data (e.g., "Missed meal + Insulin dose")
  
  @@index([patientId, targetTime(sort: Desc)])
}

model Alert {
  id            String      @id @default(uuid())
  patientId     String
  patient       Patient     @relation(fields: [patientId], references: [id], onDelete: Cascade)
  
  createdAt     DateTime    @default(now())
  resolvedAt    DateTime?
  
  type          String      // e.g., "PREDICTIVE_SPIKE", "CRITICAL_LOW"
  message       String
  severity      Severity
  status        AlertStatus @default(UNREAD)
  
  @@index([patientId, status])
  @@index([doctorId, status]) // Facilitates fast alert fetching for the doctor
}

enum Severity {
  LOW
  MEDIUM
  HIGH
  CRITICAL
}

enum AlertStatus {
  UNREAD
  ACKNOWLEDGED
  RESOLVED
}
```

---

## 3. Component Tree (Doctor's Dashboard & Digital Twin View)

This tree delineates between Server Components (data fetching) and Client Components (interactivity, hooks, rendering charts). 

### Main Dashboard (Overview)
The entry point for the doctor to monitor their entire patient cohort.

```text
DashboardLayout (Server Component)
├── SidebarNav (Client Component - Navigation: Patients, Alerts, Settings)
├── Topbar (Client Component - Global Search, Doctor Profile, Notifications)
└── DashboardOverviewPage (Server Component)
    ├── MetricsHeader (Server Component - Aggregated stats)
    │   ├── StatCard (UI - e.g., "Total Patients", "Critical Alerts")
    │   └── StatCard (UI)
    ├── RiskStratificationBoard (Client Component - Triage view)
    │   ├── HighRiskPatientsColumn
    │   │   └── PatientRiskCard (Hover shows predictive glucose context)
    │   └── MonitoringPatientsColumn
    └── RealTimeAlertFeed (Client Component - WebSocket/SSE subscription)
        └── AlertItem (UI - Highlights AI-predicted glucose spikes)
```

### Digital Twin View (`/patients/[id]`)
A highly specialized view focusing on a single patient, combining historical EHR with real-time IoT and predictive modeling.

```text
DigitalTwinPage (Server Component - Fetches initial patient hydration state)
├── PatientHeaderBar (Server Component - Sticky header with MRN, Name, quick vitals)
└── DigitalTwinGrid (Client Component - Interactive Layout)

    ├── LeftColumn (Static & Historical Context)
    │   ├── EHRSummaryPanel (Client Component)
    │   │   ├── DemographicsCard
    │   │   └── ActiveMedicationsList (Highlights diabetes medications)
    │   └── HistoricalEventTimeline (Client Component)
    │       └── TimelineNode (Shows past glucose events or interventions)

    ├── CenterColumn (The "Twin" & Real-time Telemetry)
    │   ├── 3DBodyVisualizer (Client Component - React Three Fiber)
    │   │   └── OrganHighlight (Visual glow on pancreas/liver based on metabolic stress)
    │   └── TelemetryChartSuite (Client Component - Recharts / Visx)
    │       ├── LiveGlucoseLine (Current CGM data stream)
    │       ├── AI Forecast Trajectory (Dashed line showing predicted spike path)
    │       ├── SafeZoneBands (Background coloring for target ranges)
    │       └── TimeScrubber (Slider to replay past events or view future predictions)

    └── RightColumn (Predictive Intelligence & Actions)
        ├── PredictiveInsightsPanel (Client Component)
        │   ├── RiskGaugeIndicator (Circular progress showing current spike probability)
        │   └── ExplainabilityList (e.g., "Why is this predicted? -> Post-prandial trend + delayed insulin")
        └── ClinicalActionCenter (Client Component)
            ├── SuggestedInterventions (e.g., "Message patient to take 2U fast-acting insulin")
            └── AcknowledgeAlertButton
```

### Key Technical Considerations:
* **Server Components (RSC):** Used for initial data hydration, layouts, and static elements (like EHR summaries) to reduce bundle size and speed up initial page loads.
* **Client Components:** Reserved strictly for interactive elements (`RealTimeTelemetryChart`, `3DBodyVisualizer`, `RealTimeAlertFeed`) that require `useState`, `useEffect`, or third-party charting/WebGL libraries.
* **Predictive AI Visualization:** The `TelemetryChartSuite` is designed to seamlessly blend hard, historical data (solid lines) with forecasted AI data (dashed lines with confidence intervals), allowing doctors to see the *trajectory* of a glucose spike before it happens.
* **IoT Data Volume:** The `SensorLog` table in Prisma is structured for quick insertions. For true enterprise scale, this model serves as a staging ground before archiving to a time-series optimized datastore like TimescaleDB or InfluxDB, but PostgreSQL + Prisma handles this perfectly for MVP/scaling phases.
