CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" text NOT NULL,
	"sessionId" text NOT NULL,
	"title" text NOT NULL,
	"agentId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_sessionId_unique" UNIQUE("sessionId")
);


CREATE INDEX ASYNC "sessions_userId_updatedAt_idx" ON "sessions" ("userId","updatedAt");